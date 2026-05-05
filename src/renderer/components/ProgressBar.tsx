import styles from './ProgressBar.module.css';

export interface ProgressBarProps {
  /** 0..1 inclusive. Values outside this range are clamped. */
  value: number;
  /** Optional label rendered above the bar. */
  label?: string;
  /** Optional hint rendered to the right of the label (e.g. "Step 3 of 6"). */
  hint?: string;
  'data-testid'?: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Slim accent-colored progress track. Width of the inner fill is the only
 * dynamic style — `aria-valuenow` is set to the matching percent so AT
 * announces the value cleanly.
 */
export function ProgressBar({
  value,
  label,
  hint,
  'data-testid': testId,
}: ProgressBarProps): JSX.Element {
  const ratio = clamp01(value);
  const pct = Math.round(ratio * 100);

  return (
    <div className={styles.wrap} data-testid={testId}>
      {(label || hint) && (
        <div className={styles.row}>
          {label && <span className={styles.label}>{label}</span>}
          {hint && <span className={styles.hint}>{hint}</span>}
        </div>
      )}
      <div
        className={styles.track}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={styles.fill}
          data-testid="progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
