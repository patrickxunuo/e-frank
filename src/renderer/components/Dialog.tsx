import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import styles from './Dialog.module.css';
import { IconClose } from './icons';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg' | 'full';
  'data-testid'?: string;
}

/**
 * Modal dialog. Click outside (on the backdrop) or press Esc to close.
 * Locks body scroll while open so the underlying app doesn't drift.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'lg',
  'data-testid': testId,
}: DialogProps): JSX.Element | null {
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // Focus management: capture the previously-focused element on open, focus
  // the panel for screen readers, and restore focus on close. Tab cycling is
  // intentionally not trapped — Electron's own window focus + the panel's
  // `aria-modal` attribute give AT enough context, and a half-implemented
  // trap is worse than none. Full trap can land in a follow-up if needed.
  useEffect(() => {
    if (!open) return undefined;
    const previousActive = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      if (previousActive && typeof previousActive.focus === 'function') {
        previousActive.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className={styles.backdrop}
      onMouseDown={onBackdropClick}
      data-testid={testId ?? 'dialog-backdrop'}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        className={`${styles.panel} ${styles[`size-${size}`]}`}
        data-testid="dialog-panel"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.titles}>
            <h2 id={titleId} className={styles.title} data-testid="dialog-title">
              {title}
            </h2>
            {subtitle && (
              <p id={subtitleId} className={styles.subtitle}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close dialog"
            data-testid="dialog-close"
          >
            <IconClose />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
