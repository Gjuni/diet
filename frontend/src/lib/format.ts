const nf1 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

/** 소수 첫째 자리까지 */
export const n1 = (v: number | null | undefined) => (v === null || v === undefined ? '-' : nf1.format(v));
export const n0 = (v: number | null | undefined) => (v === null || v === undefined ? '-' : nf0.format(v));
export const signed = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}`;
