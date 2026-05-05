/**
 * Tiny relative-time formatter — produces compact strings like "5m ago",
 * "3h ago", "Jan 5". Pure (no Intl.RelativeTimeFormat dependency) so output
 * is stable across locales and easy to assert in tests.
 *
 * `now` is injectable so tests can pin "current time"; production callers
 * pass nothing and get `new Date()`.
 */

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const SECONDS = 1_000;
const MINUTE = 60 * SECONDS;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Format an ISO-8601 timestamp as a compact relative string. Bands:
 *   < 60s    → "now"
 *   < 60m    → "{n}m ago"
 *   < 24h    → "{n}h ago"
 *   < 7d     → "{n}d ago"
 *   ≥ 7d     → "{Mon} {D}" (e.g. "Jan 5")
 *
 * Future timestamps (delta < 0) are treated as "now". Unparseable input
 * returns the en-dash placeholder `"—"`.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  if (typeof iso !== 'string' || iso.trim() === '') {
    return '—';
  }
  const then = new Date(iso);
  const t = then.getTime();
  if (!Number.isFinite(t)) {
    return '—';
  }
  const delta = now.getTime() - t;

  if (delta < MINUTE) {
    return 'now';
  }
  if (delta < HOUR) {
    const n = Math.floor(delta / MINUTE);
    return `${n}m ago`;
  }
  if (delta < DAY) {
    const n = Math.floor(delta / HOUR);
    return `${n}h ago`;
  }
  if (delta < WEEK) {
    const n = Math.floor(delta / DAY);
    return `${n}d ago`;
  }
  const month = MONTH_NAMES[then.getMonth()] ?? '';
  const day = then.getDate();
  return `${month} ${day}`;
}
