// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetNotificationsForTests,
  dismissAllToasts,
  dismissToast,
  dismissToastByKey,
  dispatchToast,
  getToasts,
} from '../../src/renderer/state/notifications';

/**
 * NOTIF-STORE-001..009 — module-level toast store.
 *
 * Acceptance (GH-59 "Store"):
 *  - dispatch returns an id; toast appears in getToasts with createdAt set
 *  - dedupeKey collision updates the existing toast in place
 *  - dismiss removes by id; dismissByKey removes by dedupeKey
 *  - dismissAll clears the queue
 *  - no-op dismisses don't emit (covered indirectly — store is pure)
 */

afterEach(() => {
  __resetNotificationsForTests();
});

describe('notification store', () => {
  it('NOTIF-STORE-001: dispatch appends a toast with auto-generated id + createdAt', () => {
    const before = Date.now();
    const id = dispatchToast({ type: 'success', title: 'Run done' });
    const after = Date.now();
    const toasts = getToasts();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.id).toBe(id);
    expect(toasts[0]?.title).toBe('Run done');
    expect(toasts[0]?.type).toBe('success');
    expect(toasts[0]?.createdAt).toBeGreaterThanOrEqual(before);
    expect(toasts[0]?.createdAt).toBeLessThanOrEqual(after);
  });

  it('NOTIF-STORE-002: dispatch returns a unique id per call', () => {
    const a = dispatchToast({ type: 'info', title: 'A' });
    const b = dispatchToast({ type: 'info', title: 'B' });
    expect(a).not.toBe(b);
    expect(getToasts()).toHaveLength(2);
  });

  it('NOTIF-STORE-003: dedupeKey collision updates in place (no second stack)', () => {
    const id1 = dispatchToast({
      type: 'approval',
      title: 'GH-1 — awaiting approval',
      dedupeKey: 'approval-run-1',
    });
    const beforeUpdate = getToasts()[0]?.createdAt;
    const id2 = dispatchToast({
      type: 'approval',
      title: 'GH-1 — awaiting approval (refreshed)',
      dedupeKey: 'approval-run-1',
    });

    expect(id2).toBe(id1);
    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('GH-1 — awaiting approval (refreshed)');
    expect(toasts[0]?.createdAt).toBe(beforeUpdate); // preserved
  });

  it('NOTIF-STORE-004: dedupeKey on a fresh key still appends', () => {
    dispatchToast({
      type: 'approval',
      title: 'Run A',
      dedupeKey: 'approval-run-1',
    });
    dispatchToast({
      type: 'approval',
      title: 'Run B',
      dedupeKey: 'approval-run-2',
    });
    expect(getToasts()).toHaveLength(2);
  });

  it('NOTIF-STORE-005: dismiss removes by id', () => {
    const a = dispatchToast({ type: 'info', title: 'A' });
    const b = dispatchToast({ type: 'info', title: 'B' });

    dismissToast(a);
    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.id).toBe(b);
  });

  it('NOTIF-STORE-006: dismiss on a stale id is a no-op (no throw)', () => {
    dispatchToast({ type: 'info', title: 'A' });
    expect(() => dismissToast('does-not-exist')).not.toThrow();
    expect(getToasts()).toHaveLength(1);
  });

  it('NOTIF-STORE-007: dismissByKey removes the matching toast', () => {
    dispatchToast({ type: 'info', title: 'A', dedupeKey: 'k-a' });
    dispatchToast({ type: 'info', title: 'B', dedupeKey: 'k-b' });

    dismissToastByKey('k-a');
    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe('B');
  });

  it('NOTIF-STORE-008: dismissByKey on an unknown key is a no-op', () => {
    dispatchToast({ type: 'info', title: 'A', dedupeKey: 'k-a' });
    expect(() => dismissToastByKey('k-missing')).not.toThrow();
    expect(getToasts()).toHaveLength(1);
  });

  it('NOTIF-STORE-009: dismissAll clears the queue', () => {
    dispatchToast({ type: 'info', title: 'A' });
    dispatchToast({ type: 'info', title: 'B' });
    dispatchToast({ type: 'info', title: 'C' });

    dismissAllToasts();
    expect(getToasts()).toHaveLength(0);
  });
});
