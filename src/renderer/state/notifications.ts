/**
 * Global notification (toast) store (#GH-59).
 *
 * Cross-cutting renderer state, surfaced as a bottom-right `<ToastStack />`
 * at the app shell so important run-level events reach the user regardless
 * of which page is open.
 *
 * Module-level state + `useSyncExternalStore`. Deliberately no new runtime
 * dep: the ticket originally proposed `zustand`, but React 18's external-
 * store hook plus a small in-module store gives the same ergonomics (no
 * Provider, simple test surface) without the bundle cost. Matches the
 * project's "hand-rolled when stdlib suffices" pattern from #9.
 *
 * Timer ownership lives in `<ToastStack />` (per-toast `useEffect` keyed on
 * `ttlMs`), so the store stays pure / serializable.
 */
import { useSyncExternalStore } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'approval';

export interface ToastAction {
  label: string;
  /** Either an in-app navigation handler or an IPC dispatch. */
  onClick: () => void;
  /** Optional variant — 'primary' for the main CTA, 'danger' for destructive. */
  variant?: 'primary' | 'danger';
}

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  /** Optional body — plain text only in MVP. */
  body?: string;
  /** Optional inline actions rendered at the bottom of the toast. */
  actions?: ToastAction[];
  /** ms until auto-dismiss; undefined or <= 0 means persist until user acts. */
  ttlMs?: number;
  /** Wall-clock timestamp; used for stable ordering. */
  createdAt: number;
  /**
   * Optional dedupe key. If a new toast is dispatched with a key matching
   * an existing toast, the existing one is updated in place instead of a
   * second toast stacking.
   */
  dedupeKey?: string;
}

type Listener = () => void;

let toasts: ReadonlyArray<Toast> = [];
const listeners = new Set<Listener>();
let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `toast-${idCounter}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlyArray<Toast> {
  return toasts;
}

/**
 * Dispatch a toast. If `dedupeKey` matches an existing toast, that toast
 * is updated in place (id + createdAt preserved); otherwise a fresh toast
 * is appended. Returns the toast's id.
 */
export function dispatchToast(input: Omit<Toast, 'id' | 'createdAt'>): string {
  if (input.dedupeKey) {
    const idx = toasts.findIndex((t) => t.dedupeKey === input.dedupeKey);
    const existing = idx === -1 ? undefined : toasts[idx];
    if (existing !== undefined) {
      const replaced: Toast = {
        ...existing,
        ...input,
        id: existing.id,
        createdAt: existing.createdAt,
      };
      toasts = [...toasts.slice(0, idx), replaced, ...toasts.slice(idx + 1)];
      notify();
      return existing.id;
    }
  }
  const toast: Toast = { ...input, id: nextId(), createdAt: Date.now() };
  toasts = [...toasts, toast];
  notify();
  return toast.id;
}

export function dismissToast(id: string): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    notify();
  }
}

/** Dismiss the (at most one) toast carrying the given dedupe key. */
export function dismissToastByKey(key: string): void {
  const next = toasts.filter((t) => t.dedupeKey !== key);
  if (next.length !== toasts.length) {
    toasts = next;
    notify();
  }
}

export function dismissAllToasts(): void {
  if (toasts.length > 0) {
    toasts = [];
    notify();
  }
}

/** Read the live queue. Reads outside React (e.g. dispatchers) use this. */
export function getToasts(): ReadonlyArray<Toast> {
  return toasts;
}

/**
 * React hook — subscribes to the store and returns the current toast list.
 */
export function useNotifications(): ReadonlyArray<Toast> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only — reset module state between cases. */
export function __resetNotificationsForTests(): void {
  toasts = [];
  idCounter = 0;
  listeners.clear();
}
