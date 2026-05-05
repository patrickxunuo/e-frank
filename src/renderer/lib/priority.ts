/**
 * Maps Jira priority display names to a small, stable bucket the UI uses
 * for color coding. Case-insensitive; unknown / null / empty falls through
 * to the `'neutral'` bucket so the badge still renders.
 */

export type PriorityBucket = 'high' | 'medium' | 'low' | 'neutral';

const HIGH = new Set(['highest', 'high', 'urgent', 'critical', 'blocker']);
const MEDIUM = new Set(['medium', 'normal']);
const LOW = new Set(['low', 'lowest', 'minor', 'trivial']);

export function normalizePriority(name: string | null | undefined): PriorityBucket {
  if (typeof name !== 'string') return 'neutral';
  const key = name.trim().toLowerCase();
  if (key === '') return 'neutral';
  if (HIGH.has(key)) return 'high';
  if (MEDIUM.has(key)) return 'medium';
  if (LOW.has(key)) return 'low';
  return 'neutral';
}
