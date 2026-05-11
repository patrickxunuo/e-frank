/**
 * `<Toast>` — single bottom-right notification card (#GH-59).
 *
 * Renders a glass-card surface with type-tinted accent bar, optional body
 * text, and optional action buttons. The close `×` always dispatches the
 * default `dismissToast` from the store unless an override is supplied.
 *
 * Pure presentational — no timer logic. The parent `<ToastStack />` owns
 * auto-dismiss timers so this component stays trivial to test.
 */
import { useCallback } from 'react';
import { dismissToast, type Toast as ToastModel } from '../state/notifications';
import { Button } from './Button';
import { IconAlert, IconCheck, IconClose, IconKey } from './icons';
import styles from './Toast.module.css';

export interface ToastProps {
  toast: ToastModel;
  /** Optional override for dismissal (used by tests). */
  onDismiss?: (id: string) => void;
}

function TypeIcon({ type }: { type: ToastModel['type'] }): JSX.Element | null {
  // Force size={18} so all type icons match the .icon container; the
  // base components default to varying sizes (IconCheck → 16, others → 18).
  switch (type) {
    case 'success':
      return <IconCheck size={18} />;
    case 'error':
    case 'warning':
    case 'info':
      return <IconAlert size={18} />;
    case 'approval':
      return <IconKey size={18} />;
    default:
      return null;
  }
}

function buttonVariantFor(actionVariant: 'primary' | 'danger' | undefined): 'primary' | 'destructive' | 'ghost' {
  if (actionVariant === 'primary') return 'primary';
  if (actionVariant === 'danger') return 'destructive';
  return 'ghost';
}

export function Toast({ toast, onDismiss }: ToastProps): JSX.Element {
  const handleDismiss = useCallback((): void => {
    (onDismiss ?? dismissToast)(toast.id);
  }, [onDismiss, toast.id]);

  const isUrgent = toast.type === 'error' || toast.type === 'approval';

  return (
    <div
      className={styles.toast}
      data-type={toast.type}
      data-testid={`toast-${toast.id}`}
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
    >
      <div className={styles.accent} aria-hidden="true" />
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.icon} aria-hidden="true">
            <TypeIcon type={toast.type} />
          </span>
          <span className={styles.title} data-testid="toast-title">
            {toast.title}
          </span>
          <button
            type="button"
            className={styles.close}
            onClick={handleDismiss}
            aria-label="Dismiss"
            data-testid="toast-close"
          >
            <IconClose size={12} />
          </button>
        </div>
        {toast.body !== undefined && toast.body.length > 0 && (
          <p className={styles.text} data-testid="toast-body">
            {toast.body}
          </p>
        )}
        {toast.actions && toast.actions.length > 0 && (
          <div className={styles.actions} data-testid="toast-actions">
            {toast.actions.map((action, i) => (
              <Button
                key={`${i}-${action.label}`}
                variant={buttonVariantFor(action.variant)}
                size="sm"
                onClick={action.onClick}
                data-testid={`toast-action-${i}`}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
