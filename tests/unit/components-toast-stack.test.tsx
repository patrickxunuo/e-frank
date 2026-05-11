// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ToastStack } from '../../src/renderer/components/ToastStack';
import {
  __resetNotificationsForTests,
  dispatchToast,
  type Toast as ToastModel,
} from '../../src/renderer/state/notifications';

/**
 * CMP-TOAST-STACK-001..006 — <ToastStack> behavior.
 *
 * Acceptance (GH-59 "Visual"):
 *  - empty → renders the empty marker but no toast rows
 *  - subscribes to the store; freshly dispatched toasts appear without props
 *  - up to MAX_VISIBLE (4) toasts paint; older entries (head of queue) are
 *    dropped from view
 *  - per-toast ttlMs schedules an auto-dismiss via the onDismiss callback
 *  - manual dismiss cancels the pending timer (no late dismiss callback)
 *  - non-positive ttl (0 / undefined / negative) does NOT schedule a timer
 */

afterEach(() => {
  cleanup();
  __resetNotificationsForTests();
  vi.useRealTimers();
});

beforeEach(() => {
  __resetNotificationsForTests();
});

function makeToast(over: Partial<ToastModel> = {}): ToastModel {
  return {
    id: 't',
    type: 'info',
    title: 'A',
    createdAt: 0,
    ...over,
  };
}

describe('<ToastStack />', () => {
  it('CMP-TOAST-STACK-001: renders empty marker when queue is empty', () => {
    render(<ToastStack toasts={[]} onDismiss={() => {}} />);
    const stack = screen.getByTestId('toast-stack');
    expect(stack).toHaveAttribute('data-empty', 'true');
    expect(screen.queryByTestId(/^toast-t-/)).toBeNull();
  });

  it('CMP-TOAST-STACK-002: subscribes to the store when no toasts prop given', () => {
    render(<ToastStack />);
    act(() => {
      dispatchToast({ type: 'success', title: 'Hello from store' });
    });
    expect(screen.getByTestId('toast-title')).toHaveTextContent('Hello from store');
  });

  it('CMP-TOAST-STACK-003: clamps to maxVisible, keeping the newest', () => {
    const toasts: ToastModel[] = [
      makeToast({ id: 't-1', title: 'one' }),
      makeToast({ id: 't-2', title: 'two' }),
      makeToast({ id: 't-3', title: 'three' }),
      makeToast({ id: 't-4', title: 'four' }),
      makeToast({ id: 't-5', title: 'five' }),
    ];
    render(<ToastStack toasts={toasts} maxVisible={3} onDismiss={() => {}} />);

    expect(screen.queryByTestId('toast-t-1')).toBeNull();
    expect(screen.queryByTestId('toast-t-2')).toBeNull();
    expect(screen.getByTestId('toast-t-3')).toBeInTheDocument();
    expect(screen.getByTestId('toast-t-4')).toBeInTheDocument();
    expect(screen.getByTestId('toast-t-5')).toBeInTheDocument();
  });

  it('CMP-TOAST-STACK-004: positive ttlMs schedules a dismiss', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <ToastStack
        toasts={[makeToast({ id: 't-ttl', title: 'ephemeral', ttlMs: 5_000 })]}
        onDismiss={onDismiss}
      />,
    );

    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledWith('t-ttl');
  });

  it('CMP-TOAST-STACK-005: undefined / zero / negative ttl does NOT schedule a dismiss', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const toasts: ToastModel[] = [
      makeToast({ id: 't-no-ttl', title: 'persists', ttlMs: undefined }),
      makeToast({ id: 't-zero', title: 'zero', ttlMs: 0 }),
      makeToast({ id: 't-neg', title: 'neg', ttlMs: -100 }),
    ];
    render(<ToastStack toasts={toasts} onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('CMP-TOAST-STACK-006: removing a toast before its ttl fires cancels the timer', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <ToastStack
        toasts={[makeToast({ id: 't-cancel', title: 'go away', ttlMs: 3_000 })]}
        onDismiss={onDismiss}
      />,
    );

    // Toast leaves the queue (e.g. user clicked × — the store would drop it).
    rerender(<ToastStack toasts={[]} onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
