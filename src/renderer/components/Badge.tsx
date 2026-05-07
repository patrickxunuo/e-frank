import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeVariant = 'idle' | 'running' | 'success' | 'warning' | 'danger' | 'neutral';

/**
 * `pulse` controls the dot's animation cadence.
 *  - `false` (or omitted): no dot, no animation.
 *  - `true` / `'active'`: heartbeat — the run is doing work right now.
 *  - `'waiting'`: a slower breath — the run is paused waiting on the user
 *    (e.g. at an awaitingApproval checkpoint). Communicates "still alive,
 *    just on hold" rather than "pushing forward".
 */
export type BadgePulse = boolean | 'active' | 'waiting';

export interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
  pulse?: BadgePulse;
  'data-testid'?: string;
}

/**
 * Status pill. Use `pulse` only with `running` — the soft-glow halo signals
 * "live activity in progress" without the visual noise of a full spinner.
 */
export function Badge({
  variant,
  children,
  pulse = false,
  'data-testid': testId,
}: BadgeProps): JSX.Element {
  const pulseMode: 'active' | 'waiting' | null =
    pulse === true || pulse === 'active'
      ? 'active'
      : pulse === 'waiting'
        ? 'waiting'
        : null;
  return (
    <span
      className={`${styles.badge} ${styles[variant]}`}
      data-testid={testId}
      data-variant={variant}
    >
      {pulseMode !== null && (
        <span
          className={`${styles.dot} ${pulseMode === 'active' ? styles.dotPulseActive : styles.dotPulseWaiting}`}
          data-pulse-dot
          data-pulse-mode={pulseMode}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
