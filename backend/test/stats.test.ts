import { describe, expect, it } from 'vitest';
import { detectImageMime } from '../src/lib/image.js';
import { movingAverage7, trendKgPerWeek } from '../src/services/statsCalc.js';

describe('7일 이동평균', () => {
  it('실제 날짜 기준 [d-6, d] 창 (기록 없는 날은 건너뜀)', () => {
    const r = movingAverage7([
      { date: '2026-11-01', weight_kg: 70 },
      { date: '2026-11-03', weight_kg: 69 },
      { date: '2026-11-07', weight_kg: 68 },
      { date: '2026-11-08', weight_kg: 67 }, // 11-02 ~ 11-08 → 69, 68, 67
    ]);
    expect(r.map((p) => p.ma7)).toEqual([70, 69.5, 69, 68]);
  });
});

describe('최근 4주 추세 (주당 kg)', () => {
  it('하루 0.1kg 씩 감소 → 주당 -0.7kg', () => {
    const pts = Array.from({ length: 28 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      weight_kg: 80 - i * 0.1,
    }));
    expect(trendKgPerWeek(pts)).toBeCloseTo(-0.7, 5);
  });

  it('데이터가 부족하면 null', () => {
    expect(trendKgPerWeek([{ date: '2026-11-01', weight_kg: 70 }])).toBeNull();
    expect(
      trendKgPerWeek([
        { date: '2026-11-01', weight_kg: 70 },
        { date: '2026-11-03', weight_kg: 69 },
      ]),
    ).toBeNull();
  });
});

describe('업로드 이미지 형식 판별 (매직 바이트)', () => {
  it('JPEG / PNG / WEBP / HEIC 만 허용', () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectImageMime(Buffer.from('RIFF\0\0\0\0WEBP', 'ascii'))).toBe('image/webp');
    expect(detectImageMime(Buffer.from('\0\0\0\x18ftypheic', 'latin1'))).toBe('image/heic');
    expect(detectImageMime(Buffer.from('GIF89a'))).toBeNull();
    expect(detectImageMime(Buffer.from('<svg></svg>'))).toBeNull();
  });
});
