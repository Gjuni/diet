export function ProgressBar({ value, max, label, thin }: { value: number; max: number; label: string; thin?: boolean }) {
  const ratio = max > 0 ? value / max : 0;
  const over = ratio > 1;
  return (
    <div
      className={`progress${over ? ' over' : ''}${thin ? ' thin' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
    >
      <i style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
    </div>
  );
}
