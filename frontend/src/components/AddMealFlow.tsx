import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, ApiError, errorMessage } from '../api/client';
import type { AnalysisJob, MealSlot } from '../api/types';
import { MAX_UPLOAD_BYTES, SLOT_LABEL, SLOTS } from '../lib/constants';
import { kstIso, mealSlotForHour } from '../lib/date';
import { resizeFile } from '../lib/image';
import { useServerTime } from '../time/ServerTime';
import { InAppCamera } from './InAppCamera';
import { draftFromAnalysis, draftToPayload, emptyDraft, evaluateDraft, ItemEditor, type DraftItem } from './ItemEditor';
import { PlusIcon } from './Icons';
import { Sheet } from './Sheet';

type Stage = 'choose' | 'camera' | 'analyzing' | 'review';
const FINAL = new Set(['succeeded', 'failed', 'canceled', 'expired']);

/**
 * 식사 추가: [무음 카메라 | 앨범 | 직접 입력] → (사진이면) 서버 분석 작업 → 결과 확인/수정 → 저장
 *  - 사진은 메모리에서만 다루고 기기에 저장하지 않는다. 시트를 닫으면 참조를 버린다.
 *  - 분석 중에 닫으면 서버에 취소를 보내 임시 이미지를 즉시 파기하게 한다.
 */
export function AddMealFlow({ date, onClose, onSaved }: { date: string; onClose: () => void; onSaved: () => void }) {
  const { nowKst } = useServerTime();
  const [stage, setStage] = useState<Stage>('choose');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [source, setSource] = useState<'ai' | 'manual'>('manual');
  const [time, setTime] = useState(() => nowKst().time);
  const [slot, setSlot] = useState<MealSlot>(() => mealSlotForHour(nowKst().hour));
  const [slotTouched, setSlotTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const imageRef = useRef<Blob | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const pollAbort = useRef<AbortController | null>(null);
  const albumInput = useRef<HTMLInputElement>(null);
  const nativeCamInput = useRef<HTMLInputElement>(null);

  // 정리: 미리보기 URL 해제, 진행 중 분석 취소(서버 임시 이미지 즉시 파기), 이미지 참조 제거
  useEffect(() => {
    return () => {
      pollAbort.current?.abort();
      const id = jobIdRef.current;
      if (id) void api(`/meals/analyze/${id}`, { method: 'DELETE' }).catch(() => undefined);
      imageRef.current = null;
    };
  }, []);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const onTimeChange = (v: string) => {
    setTime(v);
    if (!slotTouched && /^\d{2}:\d{2}$/.test(v)) setSlot(mealSlotForHour(Number(v.slice(0, 2))));
  };

  const startManual = () => {
    setSource('manual');
    setDrafts([emptyDraft()]);
    setStage('review');
  };

  const runAnalysis = useCallback(async (blob: Blob) => {
    setAnalysisError(null);
    setJob(null);
    setStage('analyzing');
    const ctrl = new AbortController();
    pollAbort.current = ctrl;
    try {
      const form = new FormData();
      form.append('image', blob, 'meal.jpg');
      let { job: j } = await api<{ job: AnalysisJob }>('/meals/analyze', { method: 'POST', form, signal: ctrl.signal });
      jobIdRef.current = j.id;
      setJob(j);
      while (!FINAL.has(j.status)) {
        ({ job: j } = await api<{ job: AnalysisJob }>(`/meals/analyze/${j.id}?wait=10`, { signal: ctrl.signal }));
        setJob(j);
      }
      jobIdRef.current = null; // 끝난 작업은 취소할 필요 없음
      if (j.status === 'succeeded' && j.result) {
        if (!j.result.is_food || j.result.items.length === 0) {
          setAnalysisError('사진에서 음식을 찾지 못했어요. 다른 사진을 쓰거나 직접 입력해 주세요.');
          return;
        }
        setSource('ai');
        setDrafts(j.result.items.map(draftFromAnalysis));
        imageRef.current = null; // 분석이 끝난 사진은 더 이상 들고 있지 않는다
        setStage('review');
      } else {
        setAnalysisError(j.error?.message ?? '사진을 분석하지 못했어요. 직접 입력해 주세요.');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setAnalysisError(errorMessage(err));
    }
  }, []);

  const acceptImage = async (raw: Blob) => {
    try {
      const jpeg = raw.type === 'image/jpeg' && raw.size < 1_500_000 ? raw : await resizeFile(raw);
      if (jpeg.size > MAX_UPLOAD_BYTES) {
        setAnalysisError('이미지 용량은 10MB 이하여야 해요.');
        setStage('analyzing');
        return;
      }
      imageRef.current = jpeg;
      setPreviewUrl(URL.createObjectURL(jpeg));
      await runAnalysis(jpeg);
    } catch {
      setAnalysisError('이미지를 읽지 못했어요. 다른 사진을 선택해 주세요.');
      setStage('analyzing');
    }
  };

  const onFileChosen = (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = ''; // 같은 파일 다시 선택 가능 + 참조 해제
    if (file) void acceptImage(file);
  };

  const onCameraFallback = useCallback(() => setCameraFailed(true), []);
  const onCaptured = useCallback((jpeg: Blob) => void acceptImage(jpeg), []);

  const cancelAnalysis = async () => {
    pollAbort.current?.abort();
    const id = jobIdRef.current;
    jobIdRef.current = null;
    if (id) await api(`/meals/analyze/${id}`, { method: 'DELETE' }).catch(() => undefined);
    imageRef.current = null;
    setStage('choose');
  };

  const save = async () => {
    setSaveError(null);
    const bad = drafts.map(evaluateDraft).find((e) => e.error);
    if (bad) {
      setSaveError(bad.error);
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(time)) {
      setSaveError('시각을 입력해 주세요.');
      return;
    }
    setSaving(true);
    try {
      await api('/meals', {
        method: 'POST',
        body: {
          eaten_at: kstIso(date, time),
          meal_slot: slot,
          source,
          analysis_job_id: source === 'ai' ? job?.id : undefined,
          items: drafts.map((d) => draftToPayload(d, source)),
        },
      });
      onSaved();
    } catch (err) {
      setSaveError(err instanceof ApiError || err instanceof Error ? err.message : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="식사 추가" onClose={onClose}>
      {/* 앨범 선택 (capture 없음 → 카메라 앱을 열지 않음) */}
      <input ref={albumInput} type="file" accept="image/*" hidden onChange={onFileChosen} />
      {/* 앱 내 카메라를 못 쓸 때만: 기기 카메라 앱 */}
      <input ref={nativeCamInput} type="file" accept="image/*" capture="environment" hidden onChange={onFileChosen} />

      {stage === 'choose' && (
        <div className="choice-list">
          <button type="button" className="choice" onClick={() => setStage('camera')}>
            <span className="ico" aria-hidden>
              📷
            </span>
            <span>
              <strong>사진 찍기 (무음)</strong>
              <span className="small muted">셔터음 없이 촬영, 갤러리에 저장 안 함</span>
            </span>
          </button>
          <button type="button" className="choice" onClick={() => albumInput.current?.click()}>
            <span className="ico" aria-hidden>
              🖼️
            </span>
            <span>
              <strong>앨범에서 선택</strong>
              <span className="small muted">이미 찍어 둔 음식 사진</span>
            </span>
          </button>
          <button type="button" className="choice" onClick={startManual}>
            <span className="ico" aria-hidden>
              ✏️
            </span>
            <span>
              <strong>직접 입력</strong>
              <span className="small muted">AI 없이 이름과 영양값 입력</span>
            </span>
          </button>
        </div>
      )}

      {stage === 'camera' && (
        <div className="stack">
          <InAppCamera onCapture={onCaptured} onFallback={onCameraFallback} />
          {cameraFailed && (
            <div className="stack">
              <button type="button" className="btn btn-block" onClick={() => albumInput.current?.click()}>
                앨범에서 선택
              </button>
              <button type="button" className="btn btn-block" onClick={() => nativeCamInput.current?.click()}>
                기본 카메라 앱 사용
              </button>
              <p className="tiny muted" style={{ margin: 0 }}>
                기본 카메라 앱은 기기 설정에 따라 셔터음이 나거나 갤러리에 저장될 수 있어요.
              </p>
            </div>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setStage('choose')}>
            뒤로
          </button>
        </div>
      )}

      {stage === 'analyzing' && (
        <div className="stack">
          {previewUrl && <img className="preview" src={previewUrl} alt="분석할 음식 사진" />}
          {!analysisError ? (
            <div className="card row" aria-live="polite">
              <div className="spinner" aria-hidden />
              <div className="grow">
                <strong>
                  {job?.status === 'queued' && job.queue_position && job.queue_position > 1
                    ? `분석 대기 중 (${job.queue_position}번째)`
                    : '사진을 분석하고 있어요…'}
                </strong>
                <div className="small muted">사진은 분석이 끝나면 서버에서 바로 삭제돼요.</div>
              </div>
              <button type="button" className="btn btn-sm" onClick={cancelAnalysis}>
                취소
              </button>
            </div>
          ) : (
            <div className="stack">
              <p className="notice error" role="alert">
                {analysisError}
              </p>
              <div className="grid-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => (imageRef.current ? void runAnalysis(imageRef.current) : setStage('choose'))}
                >
                  다시 시도
                </button>
                <button type="button" className="btn btn-primary" onClick={startManual}>
                  직접 입력하기
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {stage === 'review' && (
        <div className="stack">
          {source === 'ai' && (
            <p className="notice info" style={{ margin: 0 }}>
              AI 분석 결과예요. 이름·카테고리·g·영양값을 확인하고 필요하면 고쳐 주세요.
            </p>
          )}
          <div className="grid-2">
            <label className="field">
              <span>먹은 시각 (KST)</span>
              <input className="input" type="time" value={time} onChange={(e) => onTimeChange(e.target.value)} />
            </label>
            <label className="field">
              <span>끼니</span>
              <select
                className="select input"
                value={slot}
                onChange={(e) => {
                  setSlot(e.target.value as MealSlot);
                  setSlotTouched(true);
                }}
              >
                {SLOTS.map((s) => (
                  <option key={s} value={s}>
                    {SLOT_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {drafts.map((d, i) => (
            <ItemEditor
              key={d.key}
              index={i}
              draft={d}
              onChange={(next) => setDrafts((prev) => prev.map((x) => (x.key === d.key ? next : x)))}
              onRemove={drafts.length > 1 ? () => setDrafts((prev) => prev.filter((x) => x.key !== d.key)) : undefined}
            />
          ))}
          <button type="button" className="btn" onClick={() => setDrafts((p) => [...p, emptyDraft()])}>
            <PlusIcon width={18} /> 음식 추가
          </button>
          {saveError && (
            <p className="notice error" role="alert" style={{ margin: 0 }}>
              {saveError}
            </p>
          )}
          <button type="button" className="btn btn-primary btn-block" onClick={save} disabled={saving}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      )}
    </Sheet>
  );
}
