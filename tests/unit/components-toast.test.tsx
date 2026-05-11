// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Toast } from '../../src/renderer/components/Toast';
import type { Toast as ToastModel } from '../../src/renderer/state/notifications';

/**
 * CMP-TOAST-001..007 — <Toast> single-toast rendering.
 *
 * Acceptance (GH-59 "Visual" + "Approval trigger"):
 *  - title and body render
 *  - data-type attribute mirrors toast.type (drives accent bar + icon color)
 *  - close button invokes onDismiss(toast.id)
 *  - actions render Button elements; clicking fires the action's onClick
 *  - error / approval toasts use role="alert" + aria-live="assertive"
 *    so screen readers announce them
 *  - body section hidden when toast.body is empty/undefined
 *  - actions section hidden when no actions
 */

afterEach(() => {
  cleanup();
});

function makeToast(over: Partial<ToastModel> = {}): ToastModel {
  return {
    id: 't-1',
    type: 'success',
    title: 'Test toast',
    createdAt: 0,
    ...over,
  };
}

describe('<Toast />', () => {
  it('CMP-TOAST-001: renders title via data-testid="toast-title"', () => {
    render(<Toast toast={makeToast({ title: 'Hello world' })} />);
    expect(screen.getByTestId('toast-title')).toHaveTextContent('Hello world');
  });

  it('CMP-TOAST-002: data-type attribute mirrors toast.type', () => {
    const { rerender } = render(<Toast toast={makeToast({ type: 'success' })} />);
    expect(screen.getByTestId('toast-t-1')).toHaveAttribute('data-type', 'success');

    rerender(<Toast toast={makeToast({ type: 'error' })} />);
    expect(screen.getByTestId('toast-t-1')).toHaveAttribute('data-type', 'error');

    rerender(<Toast toast={makeToast({ type: 'approval' })} />);
    expect(screen.getByTestId('toast-t-1')).toHaveAttribute('data-type', 'approval');
  });

  it('CMP-TOAST-003: close button invokes onDismiss with the toast id', () => {
    const onDismiss = vi.fn();
    render(<Toast toast={makeToast({ id: 'abc' })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId('toast-close'));
    expect(onDismiss).toHaveBeenCalledWith('abc');
  });

  it('CMP-TOAST-004: body hidden when toast.body is undefined', () => {
    render(<Toast toast={makeToast({ body: undefined })} />);
    expect(screen.queryByTestId('toast-body')).toBeNull();
  });

  it('CMP-TOAST-005: actions render and fire their onClick', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <Toast
        toast={makeToast({
          type: 'approval',
          actions: [
            { label: 'Approve', variant: 'primary', onClick: onApprove },
            { label: 'Reject', variant: 'danger', onClick: onReject },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('toast-action-0'));
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('toast-action-1'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('CMP-TOAST-006: error toast uses role="alert" + aria-live="assertive"', () => {
    render(<Toast toast={makeToast({ type: 'error' })} />);
    const root = screen.getByTestId('toast-t-1');
    expect(root).toHaveAttribute('role', 'alert');
    expect(root).toHaveAttribute('aria-live', 'assertive');
  });

  it('CMP-TOAST-007: success toast uses role="status" + aria-live="polite"', () => {
    render(<Toast toast={makeToast({ type: 'success' })} />);
    const root = screen.getByTestId('toast-t-1');
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-live', 'polite');
  });
});
