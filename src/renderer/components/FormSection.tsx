import type { ReactNode } from 'react';
import styles from './FormSection.module.css';

export interface FormSectionProps {
  index: number;
  title: string;
  description?: string;
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * Numbered card for each step of the Add Project form.
 * The numbered badge anchors the eye and gives each section a clear identity.
 */
export function FormSection({
  index,
  title,
  description,
  children,
  'data-testid': testId,
}: FormSectionProps): JSX.Element {
  return (
    <section className={styles.section} data-testid={testId}>
      <header className={styles.head}>
        <span className={styles.indexBadge} aria-hidden="true">
          {index}
        </span>
        <div className={styles.titles}>
          <span className={styles.title}>{title}</span>
          {description && <span className={styles.description}>{description}</span>}
        </div>
      </header>
      <div className={styles.content}>{children}</div>
    </section>
  );
}
