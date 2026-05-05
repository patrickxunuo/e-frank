import { useLayoutEffect, useRef } from 'react';
import styles from './LogPreview.module.css';

export interface LogPreviewProps {
  /** Lines to render. Order is top-to-bottom (oldest at top). */
  lines: string[];
  /** Optional max height before scrolling. Default 120px. */
  maxHeight?: number;
  'data-testid'?: string;
}

/**
 * Fixed-height monospace log box. Whenever `lines` changes, the scroll
 * snaps to the bottom so the freshest line is visible. Uses `useLayoutEffect`
 * so the scroll-to-bottom happens synchronously after DOM updates and never
 * flashes the previous position.
 */
export function LogPreview({
  lines,
  maxHeight = 120,
  'data-testid': testId,
}: LogPreviewProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={ref}
      className={styles.box}
      style={{ maxHeight }}
      data-testid={testId}
      role="log"
      aria-live="polite"
    >
      {lines.length === 0 ? (
        <span className={styles.empty}>Awaiting output…</span>
      ) : (
        lines.map((line, i) => (
          // Index keys are fine here — the list is append-only and order is stable.
          <div key={i} className={styles.line}>
            {line}
          </div>
        ))
      )}
    </div>
  );
}
