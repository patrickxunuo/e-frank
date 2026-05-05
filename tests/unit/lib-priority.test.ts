import { describe, expect, it } from 'vitest';
import { normalizePriority } from '../../src/renderer/lib/priority';

/**
 * UTIL-PRI-001..004 — normalizePriority()
 *
 * Buckets (case-insensitive):
 *   - 'highest' | 'high' | 'urgent' | 'critical' | 'blocker' → 'high'
 *   - 'medium' | 'normal' → 'medium'
 *   - 'low' | 'lowest' | 'minor' | 'trivial' → 'low'
 *   - anything else (incl. null/undefined/empty) → 'neutral'
 */

describe('normalizePriority — UTIL-PRI', () => {
  it('UTIL-PRI-001: highest / blocker / urgent / critical / high → high', () => {
    expect(normalizePriority('Highest')).toBe('high');
    expect(normalizePriority('blocker')).toBe('high');
    expect(normalizePriority('Urgent')).toBe('high');
    expect(normalizePriority('CRITICAL')).toBe('high');
    expect(normalizePriority('high')).toBe('high');
  });

  it('UTIL-PRI-002: Medium / normal → medium', () => {
    expect(normalizePriority('Medium')).toBe('medium');
    expect(normalizePriority('normal')).toBe('medium');
    expect(normalizePriority('NORMAL')).toBe('medium');
  });

  it('UTIL-PRI-003: Low / Lowest / minor / trivial → low', () => {
    expect(normalizePriority('Low')).toBe('low');
    expect(normalizePriority('lowest')).toBe('low');
    expect(normalizePriority('Minor')).toBe('low');
    expect(normalizePriority('trivial')).toBe('low');
  });

  it('UTIL-PRI-004: null / undefined / "" / unknown name → neutral', () => {
    expect(normalizePriority(null)).toBe('neutral');
    expect(normalizePriority(undefined)).toBe('neutral');
    expect(normalizePriority('')).toBe('neutral');
    expect(normalizePriority('   ')).toBe('neutral');
    expect(normalizePriority('Banana')).toBe('neutral');
    expect(normalizePriority('P0')).toBe('neutral');
  });
});
