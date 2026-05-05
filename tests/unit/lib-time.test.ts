import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatRelative } from '../../src/renderer/lib/time';

/**
 * UTIL-TIME-001..006 — formatRelative()
 *
 * Buckets (per spec):
 *   - within 60s          → "now"
 *   - within 60min        → "{n}m ago"
 *   - within 24h          → "{n}h ago"
 *   - within 7d           → "{n}d ago"
 *   - older than 7d       → "{Mon} {D}" (e.g. "Jan 5")
 *   - unparseable input   → "—"
 *
 * We freeze "now" with vi.setSystemTime so tests are deterministic across
 * machines/timezones. The "older than 7d" assertion uses a regex (Mon name
 * + day number) rather than a hard-coded string so it remains correct
 * regardless of the runner's locale (the spec says English month abbrevs,
 * but we don't depend on the precise spelling here as long as the format
 * matches `{Mon} {D}`).
 */

const NOW = new Date('2026-05-05T12:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function isoSecondsAgo(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe('formatRelative — UTIL-TIME', () => {
  it('UTIL-TIME-001: within 60s → "now"', () => {
    expect(formatRelative(isoSecondsAgo(0))).toBe('now');
    expect(formatRelative(isoSecondsAgo(30))).toBe('now');
    expect(formatRelative(isoSecondsAgo(59))).toBe('now');
  });

  it('UTIL-TIME-002: 5 min ago → "5m ago"', () => {
    expect(formatRelative(isoSecondsAgo(5 * 60))).toBe('5m ago');
  });

  it('UTIL-TIME-003: 3 hours ago → "3h ago"', () => {
    expect(formatRelative(isoSecondsAgo(3 * 60 * 60))).toBe('3h ago');
  });

  it('UTIL-TIME-004: 4 days ago → "4d ago"', () => {
    expect(formatRelative(isoSecondsAgo(4 * 24 * 60 * 60))).toBe('4d ago');
  });

  it('UTIL-TIME-005: 30 days ago → "{Mon} {D}" format', () => {
    const result = formatRelative(isoSecondsAgo(30 * 24 * 60 * 60));
    // 3-letter English month abbreviation (Jan..Dec) followed by a day
    // number. We don't pin the exact value because any timezone offset
    // calculation may shift the date by ±1 day; the format is what
    // matters for the bucket assertion.
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    // And critically — it is NOT one of the "Nd ago" or other buckets.
    expect(result).not.toBe('now');
    expect(result).not.toMatch(/m ago$/);
    expect(result).not.toMatch(/h ago$/);
    expect(result).not.toMatch(/d ago$/);
  });

  it('UTIL-TIME-006: invalid input → "—"', () => {
    expect(formatRelative('not-a-date')).toBe('—');
    expect(formatRelative('')).toBe('—');
    // Garbage strings that Date.parse rejects:
    expect(formatRelative('lorem ipsum')).toBe('—');
  });
});
