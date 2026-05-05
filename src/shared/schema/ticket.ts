/**
 * Ticket schema — the renderer-safe shape used everywhere we expose Jira
 * issues. `ticketFromJiraIssue` is a tolerant mapper from the raw Jira
 * `/rest/api/3/search` issue object.
 *
 * No Node-only imports — this module is imported from `shared/ipc.ts` which
 * the renderer pulls in via the preload bridge.
 */

export interface Ticket {
  /** e.g. "ABC-123" — Jira issue key. */
  key: string;
  /** Issue title / summary. */
  summary: string;
  /** Display name of the status (e.g. "Ready for AI", "In Review"). */
  status: string;
  /** Display name of the priority (e.g. "High", "Medium", "Low"). */
  priority: string;
  /** Display name of the assignee, or null if unassigned. */
  assignee: string | null;
  /** ISO 8601 string from Jira (e.g. "2026-05-05T03:30:00.000+0000"). */
  updatedAt: string;
  /** Browse URL — `${host}/browse/${key}`. */
  url: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Tolerant mapping: returns `null` if the object can't plausibly be a Jira
 * issue (no `key` or no `fields`). Missing optional fields fall back to
 * sensible defaults — `"Unknown"` for status/priority, `null` for assignee.
 *
 * `host` is appended unmodified to build the browse URL; callers pass the
 * project's configured Jira host without a trailing slash.
 */
export function ticketFromJiraIssue(input: unknown, host: string): Ticket | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const key = input['key'];
  if (typeof key !== 'string' || key === '') {
    return null;
  }

  const fields = input['fields'];
  if (!isPlainObject(fields)) {
    return null;
  }

  const summary = typeof fields['summary'] === 'string' ? (fields['summary'] as string) : '';

  let status = 'Unknown';
  const statusRaw = fields['status'];
  if (isPlainObject(statusRaw) && typeof statusRaw['name'] === 'string' && statusRaw['name'] !== '') {
    status = statusRaw['name'] as string;
  }

  let priority = 'Unknown';
  const priorityRaw = fields['priority'];
  if (
    isPlainObject(priorityRaw) &&
    typeof priorityRaw['name'] === 'string' &&
    priorityRaw['name'] !== ''
  ) {
    priority = priorityRaw['name'] as string;
  }

  let assignee: string | null = null;
  const assigneeRaw = fields['assignee'];
  if (isPlainObject(assigneeRaw)) {
    if (typeof assigneeRaw['displayName'] === 'string' && assigneeRaw['displayName'] !== '') {
      assignee = assigneeRaw['displayName'] as string;
    }
  }

  const updatedAt = typeof fields['updated'] === 'string' ? (fields['updated'] as string) : '';

  return {
    key,
    summary,
    status,
    priority,
    assignee,
    updatedAt,
    url: `${host}/browse/${key}`,
  };
}
