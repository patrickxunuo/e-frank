import { describe, it, expect } from 'vitest';
import {
  ticketFromJiraIssue,
  type Ticket,
} from '../../src/shared/schema/ticket';

/**
 * Ticket schema acceptance tests (TICKET-001 .. TICKET-005).
 *
 * Exercises `ticketFromJiraIssue(input, host)` against realistic Jira REST
 * `/rest/api/3/search` issue shapes. The mapper must be tolerant of missing
 * optional fields: per spec it falls back to `"Unknown"` for status/priority
 * and `null` for assignee, but returns `null` if the input clearly is not a
 * Jira issue (no `key`, no `fields`).
 */

const HOST = 'https://example.atlassian.net';

// Full Jira REST v3 issue shape — the search response wraps these in
// `{ total, issues: [...] }`. Field names are deliberately verbose to mirror
// the real API.
function fullIssue() {
  return {
    id: '10001',
    self: `${HOST}/rest/api/3/issue/10001`,
    key: 'ABC-123',
    fields: {
      summary: 'Implement Jira polling',
      status: { name: 'Ready for AI', id: '10000' },
      priority: { name: 'High', id: '2' },
      assignee: {
        accountId: '5b10a2844c20165700ede21g',
        displayName: 'Alice Example',
        emailAddress: 'alice@example.com',
      },
      updated: '2026-05-05T03:30:00.000+0000',
    },
  };
}

describe('ticketFromJiraIssue', () => {
  // -------------------------------------------------------------------------
  // TICKET-001 — full mapping
  // -------------------------------------------------------------------------
  describe('TICKET-001 full mapping', () => {
    it('TICKET-001: full Jira issue → fully populated Ticket', () => {
      const ticket = ticketFromJiraIssue(fullIssue(), HOST);

      expect(ticket).not.toBeNull();
      if (ticket === null) return;

      expect(ticket.key).toBe('ABC-123');
      expect(ticket.summary).toBe('Implement Jira polling');
      expect(ticket.status).toBe('Ready for AI');
      expect(ticket.priority).toBe('High');
      expect(ticket.assignee).toBe('Alice Example');
      expect(ticket.updatedAt).toBe('2026-05-05T03:30:00.000+0000');
      expect(ticket.url).toBe(`${HOST}/browse/ABC-123`);
    });
  });

  // -------------------------------------------------------------------------
  // TICKET-002 — missing priority defaults to "Unknown"
  // -------------------------------------------------------------------------
  describe('TICKET-002 missing priority', () => {
    it('TICKET-002: missing priority → "Unknown"', () => {
      const issue = fullIssue();
      // Strip the priority field — Jira does this when no priority is set.
      delete (issue.fields as Record<string, unknown>)['priority'];

      const ticket = ticketFromJiraIssue(issue, HOST);
      expect(ticket).not.toBeNull();
      if (ticket === null) return;
      expect(ticket.priority).toBe('Unknown');
    });

    it('TICKET-002: priority as null → "Unknown"', () => {
      const issue = fullIssue();
      (issue.fields as Record<string, unknown>)['priority'] = null;

      const ticket = ticketFromJiraIssue(issue, HOST);
      expect(ticket).not.toBeNull();
      if (ticket === null) return;
      expect(ticket.priority).toBe('Unknown');
    });

    it('TICKET-002: missing status → "Unknown"', () => {
      const issue = fullIssue();
      delete (issue.fields as Record<string, unknown>)['status'];

      const ticket = ticketFromJiraIssue(issue, HOST);
      expect(ticket).not.toBeNull();
      if (ticket === null) return;
      expect(ticket.status).toBe('Unknown');
    });
  });

  // -------------------------------------------------------------------------
  // TICKET-003 — assignee null
  // -------------------------------------------------------------------------
  describe('TICKET-003 assignee null', () => {
    it('TICKET-003: explicit null assignee → ticket.assignee === null', () => {
      const issue = fullIssue();
      (issue.fields as Record<string, unknown>)['assignee'] = null;

      const ticket = ticketFromJiraIssue(issue, HOST);
      expect(ticket).not.toBeNull();
      if (ticket === null) return;
      expect(ticket.assignee).toBeNull();
    });

    it('TICKET-003: missing assignee field → ticket.assignee === null', () => {
      const issue = fullIssue();
      delete (issue.fields as Record<string, unknown>)['assignee'];

      const ticket = ticketFromJiraIssue(issue, HOST);
      expect(ticket).not.toBeNull();
      if (ticket === null) return;
      expect(ticket.assignee).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // TICKET-004 — URL formatting
  // -------------------------------------------------------------------------
  describe('TICKET-004 URL formatting', () => {
    it('TICKET-004: url is exactly `${host}/browse/${key}`', () => {
      const ticket = ticketFromJiraIssue(fullIssue(), HOST);
      expect(ticket).not.toBeNull();
      if (ticket === null) return;
      expect(ticket.url).toBe(`${HOST}/browse/ABC-123`);
    });

    it('TICKET-004: different host + key produces matching url', () => {
      const otherHost = 'https://my-team.atlassian.net';
      const issue = fullIssue();
      issue.key = 'XYZ-9';
      const ticket = ticketFromJiraIssue(issue, otherHost);
      expect(ticket).not.toBeNull();
      if (ticket === null) return;
      expect(ticket.url).toBe('https://my-team.atlassian.net/browse/XYZ-9');
    });
  });

  // -------------------------------------------------------------------------
  // TICKET-005 — garbage input → null
  // -------------------------------------------------------------------------
  describe('TICKET-005 garbage input', () => {
    it('TICKET-005: empty object → null', () => {
      expect(ticketFromJiraIssue({}, HOST)).toBeNull();
    });

    it('TICKET-005: missing key → null', () => {
      expect(
        ticketFromJiraIssue({ fields: { summary: 'x' } }, HOST),
      ).toBeNull();
    });

    it('TICKET-005: missing fields → null', () => {
      expect(ticketFromJiraIssue({ key: 'ABC-1' }, HOST)).toBeNull();
    });

    it('TICKET-005: non-object inputs → null', () => {
      expect(ticketFromJiraIssue(null, HOST)).toBeNull();
      expect(ticketFromJiraIssue(undefined, HOST)).toBeNull();
      expect(ticketFromJiraIssue('not an issue', HOST)).toBeNull();
      expect(ticketFromJiraIssue(42, HOST)).toBeNull();
      expect(ticketFromJiraIssue([], HOST)).toBeNull();
    });

    it('TICKET-005: typed return is `Ticket | null`', () => {
      const result = ticketFromJiraIssue(fullIssue(), HOST);
      // Compile-time check: result must be narrowed to Ticket after the
      // null-guard or a TypeScript error here would surface during typecheck.
      if (result !== null) {
        const ticket: Ticket = result;
        expect(typeof ticket.key).toBe('string');
      }
    });
  });
});
