import { useEffect, useRef, useState } from 'react';
import { captureVideoFrame } from '../lib/image';

/**
 * 앱 내부 카메라 — 무음 촬영, 갤러리에 저장하지 않음
 *
 *  휴대폰 기본 카메라 앱(<input capture>)을 쓰면 셔터음(국내 기기는 강제)이 나고
 *  기기 설정에 따라 사진이 갤러리에 남는다. 그래서 getUserMedia 로 카메라 영상을 직접 받아
 *  "현재 프레임"을 canvas 로 복사한다.
 *   - 셔터음 없음: 카메라 앱의 촬영 기능을 쓰지 않고 영상 프레임만 복사한다 (화면 플래시로만 피드백).
 *   - 저장 없음: 결과는 메모리 Blob 이며, 서버 분석이 끝나면 버려진다. 파일/갤러리/캐시에 쓰지 않는다.
 *   - 카메라는 이 화면이 열려 있는 동안만 켜지고, 닫히면 즉시 끈다(브라우저 카메라 표시등도 꺼짐).
 */
export function InAppCamera({
  onCapture,
  onFallback,
}: {
  onCapture: (jpeg: Blob) => void;
  /** 카메라를 쓸 수 없을 때 (권한 거부/미지원) */
  onFallback: (reason: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'starting' | 'live' | 'error'>('starting');
  const [message, setMessage] = useState('');
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('error');
        setMessage('이 브라우저는 앱 내 카메라를 지원하지 않아요.');
        onFallback('unsupported');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        setState('live');
      } catch (err) {
        const name = (err as DOMException)?.name;
        setState('error');
        const msg =
          name === 'NotAllowedError'
            ? '카메라 권한이 꺼져 있어요. 브라우저 설정에서 카메라를 허용하거나 앨범에서 선택해 주세요.'
            : name === 'NotFoundError'
              ? '사용할 수 있는 카메라가 없어요.'
              : window.isSecureContext
                ? '카메라를 시작하지 못했어요.'
                : '카메라는 HTTPS 에서만 사용할 수 있어요.';
        setMessage(msg);
        onFallback(name || 'error');
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [onFallback]);

  const shoot = async () => {
    const v = videoRef.current;
    if (!v || state !== 'live' || busy || !v.videoWidth) return;
    setBusy(true);
    setFlash(true);
    setTimeout(() => setFlash(false), 60);
    try {
      const blob = await captureVideoFrame(v);
      // 촬영 직후 카메라 끄기
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      onCapture(blob);
    } catch {
      setBusy(false);
      setMessage('촬영에 실패했어요. 다시 시도해 주세요.');
    }
  };

  return (
    <div className="stack">
      <div className="camera">
        {/* muted + playsInline: iOS 에서 소리 없이 인라인 재생 */}
        <video ref={videoRef} muted playsInline autoPlay aria-label="카메라 미리보기" />
        <div className={`flash${flash ? ' on' : ''}`} />
        {state === 'starting' && <div className="cam-msg">카메라를 켜는 중…</div>}
        {state === 'error' && <div className="cam-msg">{message}</div>}
        {state === 'live' && (
          <button type="button" className="shutter" onClick={shoot} disabled={busy} aria-label="촬영 (무음)" />
        )}
      </div>
      <p className="tiny muted center" style={{ margin: 0 }}>
        🔇 셔터음 없이 촬영되고, 사진은 휴대폰 갤러리에 저장되지 않아요. 분석이 끝나면 서버에서도 바로 삭제돼요.
      </p>
    </div>
  );
}
