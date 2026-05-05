import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeVariant = 'idle' | 'running' | 'success' | 'warning' | 'danger' | 'neutral';

export interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
  pulse?: boolean;
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
  return (
    <span
      className={`${styles.badge} ${styles[variant]}`}
      data-testid={testId}
      data-variant={variant}
    >
      {pulse && (
        <span
          className={`${styles.dot} ${styles.dotPulse}`}
          data-pulse-dot
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
