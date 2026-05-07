import { describe, it, expect } from 'vitest';
import { ticketFromGithubIssue } from '../../src/shared/schema/ticket';

/**
 * GH-ISSUES-MAP-001..004 — `ticketFromGithubIssue` mapper.
 *
 * Per the spec:
 *  - key: `${repoSlug}#${number}` (e.g. `gazhang/foo#123`)
 *  - summary: input.title
 *  - status: 'Open' if state==='open', 'Closed' if 'closed'
 *  - priority: derived from `priority/{high|medium|low}` labels (case-insensitive);
 *              else '—'
 *  - assignee: input.assignee?.login if present, else null
 *  - updatedAt: input.updated_at
 *  - url: input.html_url
 *  - returns null if input has a `pull_request` field (GitHub's /issues
 *    endpoint conflates issues and PRs; PRs must be filtered out).
 */

const REPO_SLUG = 'gazhang/foo';

const ghIssueRaw = {
  number: 123,
  title: 'Implement foo',
  state: 'open',
  html_url: 'https://github.com/gazhang/foo/issues/123',
  updated_at: '2026-05-05T10:00:00Z',
  labels: [{ name: 'bug' }, { name: 'priority/high' }],
  assignee: { login: 'gazhang' },
};

const ghPrRaw = {
  ...ghIssueRaw,
  number: 124,
  pull_request: { url: 'https://api.github.com/repos/gazhang/foo/pulls/124' },
};

describe('ticketFromGithubIssue — GH-ISSUES-MAP', () => {
  // -------------------------------------------------------------------------
  // GH-ISSUES-MAP-001 — happy path
  // -------------------------------------------------------------------------
  it('GH-ISSUES-MAP-001: maps title/state/assignee/updated_at/url correctly', () => {
    const t = ticketFromGithubIssue(ghIssueRaw, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.summary).toBe('Implement foo');
    expect(t.status).toBe('Open');
    expect(t.assignee).toBe('gazhang');
    expect(t.updatedAt).toBe('2026-05-05T10:00:00Z');
    expect(t.url).toBe('https://github.com/gazhang/foo/issues/123');
  });

  it('GH-ISSUES-MAP-001: closed issue → status === "Closed"', () => {
    const closed = { ...ghIssueRaw, state: 'closed' };
    const t = ticketFromGithubIssue(closed, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.status).toBe('Closed');
  });

  it('GH-ISSUES-MAP-001: missing assignee → assignee === null', () => {
    const noAssignee: Record<string, unknown> = { ...ghIssueRaw };
    delete noAssignee['assignee'];
    const t = ticketFromGithubIssue(noAssignee, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.assignee).toBeNull();
  });

  it('GH-ISSUES-MAP-001: assignee === null in raw → assignee === null on Ticket', () => {
    const nullAssignee = { ...ghIssueRaw, assignee: null };
    const t = ticketFromGithubIssue(nullAssignee, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.assignee).toBeNull();
  });

  // -------------------------------------------------------------------------
  // GH-ISSUES-MAP-002 — priority from labels
  // -------------------------------------------------------------------------
  it('GH-ISSUES-MAP-002: priority/high label → priority is the captured value (case insensitive)', () => {
    const t = ticketFromGithubIssue(ghIssueRaw, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    // The captured group is "high" — implementation may title-case ("High") or
    // keep verbatim. Either is acceptable as long as it's a non-empty
    // priority-shaped string.
    expect(t.priority.toLowerCase()).toBe('high');
  });

  it('GH-ISSUES-MAP-002: priority/medium → medium', () => {
    const issue = {
      ...ghIssueRaw,
      labels: [{ name: 'PRIORITY/Medium' }],
    };
    const t = ticketFromGithubIssue(issue, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.priority.toLowerCase()).toBe('medium');
  });

  it('GH-ISSUES-MAP-002: priority/low → low', () => {
    const issue = { ...ghIssueRaw, labels: [{ name: 'priority/low' }] };
    const t = ticketFromGithubIssue(issue, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.priority.toLowerCase()).toBe('low');
  });

  it('GH-ISSUES-MAP-002: no priority label → priority is "—" (em dash)', () => {
    const issue = { ...ghIssueRaw, labels: [{ name: 'bug' }] };
    const t = ticketFromGithubIssue(issue, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.priority).toBe('—');
  });

  it('GH-ISSUES-MAP-002: no labels at all → priority is "—"', () => {
    const issue: Record<string, unknown> = { ...ghIssueRaw, labels: [] };
    const t = ticketFromGithubIssue(issue, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.priority).toBe('—');
  });

  // -------------------------------------------------------------------------
  // GH-ISSUES-MAP-003 — PR-shaped objects return null
  // -------------------------------------------------------------------------
  it('GH-ISSUES-MAP-003: object with pull_request field → null (filtered out)', () => {
    const t = ticketFromGithubIssue(ghPrRaw, REPO_SLUG);
    expect(t).toBeNull();
  });

  it('GH-ISSUES-MAP-003: object whose pull_request is an empty object still → null', () => {
    const pr = { ...ghIssueRaw, pull_request: {} };
    const t = ticketFromGithubIssue(pr, REPO_SLUG);
    expect(t).toBeNull();
  });

  // -------------------------------------------------------------------------
  // GH-ISSUES-MAP-004 — key format
  // -------------------------------------------------------------------------
  it('GH-ISSUES-MAP-004: key is `${repoSlug}#${number}`', () => {
    const t = ticketFromGithubIssue(ghIssueRaw, REPO_SLUG);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.key).toBe('gazhang/foo#123');
  });

  it('GH-ISSUES-MAP-004: different repoSlug + number flow into the key', () => {
    const t = ticketFromGithubIssue({ ...ghIssueRaw, number: 9 }, 'octocat/hello');
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.key).toBe('octocat/hello#9');
  });

  // -------------------------------------------------------------------------
  // Defensive: garbage input returns null rather than throwing
  // -------------------------------------------------------------------------
  it('returns null for null / non-object input (defensive)', () => {
    expect(ticketFromGithubIssue(null, REPO_SLUG)).toBeNull();
    expect(ticketFromGithubIssue('string', REPO_SLUG)).toBeNull();
    expect(ticketFromGithubIssue(42, REPO_SLUG)).toBeNull();
    expect(ticketFromGithubIssue([{}], REPO_SLUG)).toBeNull();
  });

  it('returns null when number or title is missing', () => {
    const noNumber: Record<string, unknown> = { ...ghIssueRaw };
    delete noNumber['number'];
    expect(ticketFromGithubIssue(noNumber, REPO_SLUG)).toBeNull();

    const noTitle: Record<string, unknown> = { ...ghIssueRaw };
    delete noTitle['title'];
    expect(ticketFromGithubIssue(noTitle, REPO_SLUG)).toBeNull();
  });
});
