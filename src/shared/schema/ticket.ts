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

/**
 * Tolerant mapping from a raw GitHub issue object (as returned by
 * `/repos/{slug}/issues`) to a `Ticket`. Returns `null` for:
 *   - non-objects
 *   - PR-shaped issues (presence of `pull_request` field — GitHub's
 *     `/issues` endpoint conflates issues and PRs)
 *   - issues missing a numeric `number` or string `title`
 *
 * Mapping rules:
 *   - `key`     = `GH-${number}` (e.g. "GH-123"). The workflow runner's
 *     ticket-key regex (`/^[A-Z][A-Z0-9_]*-\\d+$/`) and the branch /
 *     commit-scope formats both require this shape. `repoSlug` is no longer
 *     part of the key — keys are scoped per-project (a project has exactly
 *     one issues repo), so the bare `GH-N` stays unique within a project's
 *     run history.
 *   - `summary` = `title`
 *   - `status`  = "Open" | "Closed" derived from `state`
 *   - `priority`= derived from `priority/high|medium|low` labels (case-
 *     insensitive). If multiple match, the first encountered wins; if none
 *     match, falls back to "—" (em-dash).
 *   - `assignee`= `assignee.login` if present, else `null`
 *   - `updatedAt` = `updated_at` (ISO 8601)
 *   - `url`     = `html_url`
 */
export function ticketFromGithubIssue(
  input: unknown,
  // `repoSlug` was previously used to construct `${slug}#${number}` keys.
  // Kept in the signature for call-site compatibility; intentionally
  // unprefixed-underscored. The current key format is `GH-{number}` which
  // satisfies the workflow runner's ticket-key regex.
  _repoSlug: string,
): Ticket | null {
  if (!isPlainObject(input)) {
    return null;
  }
  // GitHub returns PRs through `/issues` too — discriminator is the
  // `pull_request` field. Filter them out unconditionally.
  if (input['pull_request'] !== undefined) {
    return null;
  }

  const numberRaw = input['number'];
  if (typeof numberRaw !== 'number' || !Number.isFinite(numberRaw)) {
    return null;
  }
  const titleRaw = input['title'];
  if (typeof titleRaw !== 'string') {
    return null;
  }

  const stateRaw = input['state'];
  let status = 'Open';
  if (stateRaw === 'closed') {
    status = 'Closed';
  } else if (stateRaw === 'open') {
    status = 'Open';
  }

  // priority: scan labels for `priority/high|medium|low`. Labels can be
  // either a string or a `{ name: string }` object — accept both shapes.
  let priority = '—';
  const labelsRaw = input['labels'];
  if (Array.isArray(labelsRaw)) {
    for (const lbl of labelsRaw) {
      let labelName: string | null = null;
      if (typeof lbl === 'string') {
        labelName = lbl;
      } else if (isPlainObject(lbl) && typeof lbl['name'] === 'string') {
        labelName = lbl['name'] as string;
      }
      if (labelName === null) continue;
      const m = /^priority\/(high|medium|low)$/i.exec(labelName);
      if (m && m[1] !== undefined) {
        const level = m[1].toLowerCase();
        priority = level.charAt(0).toUpperCase() + level.slice(1);
        break;
      }
    }
  }

  let assignee: string | null = null;
  const assigneeRaw = input['assignee'];
  if (
    isPlainObject(assigneeRaw) &&
    typeof assigneeRaw['login'] === 'string' &&
    assigneeRaw['login'] !== ''
  ) {
    assignee = assigneeRaw['login'] as string;
  }

  const updatedAt =
    typeof input['updated_at'] === 'string' ? (input['updated_at'] as string) : '';
  const url = typeof input['html_url'] === 'string' ? (input['html_url'] as string) : '';

  return {
    key: `GH-${numberRaw}`,
    summary: titleRaw,
    status,
    priority,
    assignee,
    updatedAt,
    url,
  };
}
