import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  'data-testid'?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  'data-testid': testId,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={styles.empty} data-testid={testId}>
      {icon && <span className={styles.iconBubble}>{icon}</span>}
      <span className={styles.title}>{title}</span>
      {description && <span className={styles.subtitle}>{description}</span>}
      {action && <div className={styles.cta}>{action}</div>}
    </div>
  );
}
