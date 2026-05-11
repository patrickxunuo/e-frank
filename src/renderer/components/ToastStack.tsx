/**
 * `<ToastStack>` — bottom-right anchored notification stack (#GH-59).
 *
 * Mounted at the app shell root. Subscribes to the notification store and
 * renders up to `MAX_VISIBLE` toasts; older toasts that overflow remain in
 * the store but are not painted (no history surface in MVP).
 *
 * Owns per-toast auto-dismiss timers. Each toast with a positive `ttlMs`
 * gets a one-shot `setTimeout` keyed on its id. Timers persist across
 * reorderings; they clear when the toast leaves the store (either via
 * the timer itself or a manual dismiss).
 */
import { useEffect, useMemo, useRef } from 'react';
import { dismissToast, useNotifications, type Toast as ToastModel } from '../state/notifications';
import { Toast } from './Toast';
import styles from './ToastStack.module.css';

const MAX_VISIBLE = 4;

export interface ToastStackProps {
  /** Optional override (for tests that bypass the store). */
  toasts?: ReadonlyArray<ToastModel>;
  /** Optional dismiss override (for tests). */
  onDismiss?: (id: string) => void;
  /** Optional max-visible override (for tests). Defaults to MAX_VISIBLE. */
  maxVisible?: number;
}

export function ToastStack(props: ToastStackProps = {}): JSX.Element {
  const subscribed = useNotifications();
  const toasts = props.toasts ?? subscribed;
  const dismiss = props.onDismiss ?? dismissToast;
  const maxVisible = props.maxVisible ?? MAX_VISIBLE;

  // Show the newest N at the bottom (column-reverse stacks newest visually
  // lowest). Slice from the tail so the newest toasts win when the queue
  // overflows.
  const visible = useMemo(() => toasts.slice(-maxVisible), [toasts, maxVisible]);

  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Sync the timer map against the current toast list.
  useEffect(() => {
    const timers = timersRef.current;
    const liveIds = new Set(toasts.map((t) => t.id));

    // Cancel timers for toasts that left the queue (manual dismiss, etc.).
    for (const [id, handle] of Array.from(timers.entries())) {
      if (!liveIds.has(id)) {
        clearTimeout(handle);
        timers.delete(id);
      }
    }

    // Schedule timers for any positive-ttl toasts that don't already have one.
    for (const toast of toasts) {
      if (typeof toast.ttlMs !== 'number' || toast.ttlMs <= 0) continue;
      if (timers.has(toast.id)) continue;
      const handle = setTimeout(() => {
        timers.delete(toast.id);
        dismiss(toast.id);
      }, toast.ttlMs);
      timers.set(toast.id, handle);
    }
  }, [toasts, dismiss]);

  // Cleanup on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, []);

  if (visible.length === 0) {
    return (
      <div
        className={styles.stack}
        aria-hidden="true"
        data-testid="toast-stack"
        data-empty="true"
      />
    );
  }

  return (
    <div
      className={styles.stack}
      role="region"
      aria-label="Notifications"
      data-testid="toast-stack"
      data-empty="false"
    >
      {visible.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}
