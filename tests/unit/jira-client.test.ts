import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeHttpClient,
  type HttpResult,
} from '../../src/main/modules/http-client';
import {
  JiraClient,
  type JiraAuth,
} from '../../src/main/modules/jira-client';

/**
 * JiraClient acceptance tests (JIRA-001 .. JIRA-012).
 *
 * Every test constructs a fresh `JiraClient` over a `FakeHttpClient` so no
 * real Jira host is contacted. JIRA-011 is the security backstop: the API
 * token literal must NEVER appear inside any error.message returned by the
 * client.
 */

const HOST = 'https://example.atlassian.net';
const TOKEN = 'super-secret-token-XYZ';
const EMAIL = 'me@example.com';

function auth(): JiraAuth {
  return { email: EMAIL, apiToken: TOKEN };
}

function makeClient(http: FakeHttpClient): JiraClient {
  return new JiraClient({ httpClient: http, host: HOST, auth: auth() });
}

function jsonOk(body: unknown, status = 200): HttpResult {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  };
}

function jsonStatus(status: number, body: unknown = {}): HttpResult {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  };
}

function searchResponse(issues: unknown[], total = issues.length): unknown {
  return {
    startAt: 0,
    maxResults: 50,
    total,
    issues,
  };
}

function fullIssue(key: string, over: Record<string, unknown> = {}) {
  return {
    id: '10001',
    self: `${HOST}/rest/api/3/issue/10001`,
    key,
    fields: {
      summary: `Summary for ${key}`,
      status: { name: 'Ready for AI' },
      priority: { name: 'High' },
      assignee: { displayName: 'Alice Example' },
      updated: '2026-05-05T03:30:00.000+0000',
      ...over,
    },
  };
}

const SEARCH_PREFIX = `${HOST}/rest/api/3/search`;
const MYSELF_URL = `${HOST}/rest/api/3/myself`;

describe('JiraClient', () => {
  let http: FakeHttpClient;
  let client: JiraClient;

  beforeEach(() => {
    http = new FakeHttpClient();
    client = makeClient(http);
  });

  // -------------------------------------------------------------------------
  // JIRA-001 — search() happy path
  // -------------------------------------------------------------------------
  it('JIRA-001: search() happy path returns mapped tickets', async () => {
    http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(searchResponse([fullIssue('ABC-1'), fullIssue('ABC-2')])),
    );

    const res = await client.search('project = "ABC"');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.data.total).toBe(2);
    expect(res.data.tickets).toHaveLength(2);
    for (const ticket of res.data.tickets) {
      expect(typeof ticket.key).toBe('string');
      expect(typeof ticket.summary).toBe('string');
      expect(typeof ticket.status).toBe('string');
      expect(typeof ticket.priority).toBe('string');
      // assignee may be string or null; we just check the field exists.
      expect('assignee' in ticket).toBe(true);
      expect(typeof ticket.updatedAt).toBe('string');
      expect(ticket.url).toBe(`${HOST}/browse/${ticket.key}`);
    }
  });

  // -------------------------------------------------------------------------
  // JIRA-002 — JQL URL-encoding
  // -------------------------------------------------------------------------
  it('JIRA-002: JQL is URL-encoded in the outgoing request', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonOk(searchResponse([])));

    const jql = 'project = "ABC"';
    await client.search(jql);

    expect(http.calls).toHaveLength(1);
    const url = http.calls[0]?.url ?? '';
    // Per spec: `jql=${encodeURIComponent(jql)}`. Spaces → `%20`, `=` → `%3D`,
    // `"` → `%22`. The test does NOT pin the exact ordering of params — only
    // that the encoded JQL appears and the raw form does not.
    expect(url).toContain('jql=project%20%3D%20%22ABC%22');
    expect(url).not.toContain('jql=project = "ABC"');
  });

  // -------------------------------------------------------------------------
  // JIRA-003 — extra spaces / quotes / no double-encoding
  // -------------------------------------------------------------------------
  it('JIRA-003: extra spaces and quotes encoded once, not double-encoded', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonOk(searchResponse([])));

    const jql = 'project = "AB C" AND status = "In Progress"';
    await client.search(jql);

    const url = http.calls[0]?.url ?? '';
    // Single-encoded check: encodeURIComponent of the JQL must appear verbatim.
    expect(url).toContain(`jql=${encodeURIComponent(jql)}`);
    // Double-encode would replace `%` with `%25` — spot-check that we do NOT
    // see the double-encoded artifact for any space.
    expect(url).not.toContain('%2520');
  });

  // -------------------------------------------------------------------------
  // JIRA-004 — auth header on every request
  // -------------------------------------------------------------------------
  it('JIRA-004: every request carries Basic auth + Accept JSON header', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonOk(searchResponse([])));
    http.expect('GET', MYSELF_URL, jsonOk({ accountId: 'a', displayName: 'A', emailAddress: EMAIL }));

    await client.search('project = "X"');
    await client.testConnection();

    expect(http.calls.length).toBeGreaterThanOrEqual(2);
    const expected = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;
    for (const call of http.calls) {
      const headers = call.headers ?? {};
      // Header keys may be normalized — match case-insensitively.
      const auth = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === 'authorization',
      );
      const accept = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === 'accept',
      );
      expect(auth).toBeDefined();
      expect(auth?.[1]).toBe(expected);
      expect(accept).toBeDefined();
      expect(accept?.[1]).toBe('application/json');
    }
  });

  // -------------------------------------------------------------------------
  // JIRA-005..007 — status code mapping
  // -------------------------------------------------------------------------
  it('JIRA-005: search() 401 → AUTH', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(401, { errorMessages: ['Unauthorized'] }));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('AUTH');
    expect(res.error.status).toBe(401);
  });

  it('JIRA-005: search() 403 → AUTH', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(403, {}));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('AUTH');
    expect(res.error.status).toBe(403);
  });

  it('JIRA-006: search() 429 → RATE_LIMITED', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(429, {}));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('RATE_LIMITED');
    expect(res.error.status).toBe(429);
  });

  it('JIRA-007: search() 500 → SERVER_ERROR', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(500, {}));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SERVER_ERROR');
    expect(res.error.status).toBe(500);
  });

  it('JIRA-007: search() 503 → SERVER_ERROR (any 5xx)', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(503, {}));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SERVER_ERROR');
  });

  // -------------------------------------------------------------------------
  // JIRA-008 — malformed JSON → INVALID_RESPONSE
  // -------------------------------------------------------------------------
  it('JIRA-008: search() 200 with malformed JSON → INVALID_RESPONSE', async () => {
    http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk('{ this is { not valid json'),
    );
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVALID_RESPONSE');
  });

  // -------------------------------------------------------------------------
  // JIRA-009 — testConnection() happy path
  // -------------------------------------------------------------------------
  it('JIRA-009: testConnection() happy path', async () => {
    http.expect(
      'GET',
      MYSELF_URL,
      jsonOk({
        accountId: '5b10a2844c20165700ede21g',
        displayName: 'Alice Example',
        emailAddress: EMAIL,
      }),
    );
    const res = await client.testConnection();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.accountId).toBe('5b10a2844c20165700ede21g');
    expect(res.data.displayName).toBe('Alice Example');
    expect(res.data.emailAddress).toBe(EMAIL);
  });

  // -------------------------------------------------------------------------
  // JIRA-010 — testConnection() 401
  // -------------------------------------------------------------------------
  it('JIRA-010: testConnection() 401 → AUTH', async () => {
    http.expect('GET', MYSELF_URL, jsonStatus(401, {}));
    const res = await client.testConnection();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('AUTH');
  });

  // -------------------------------------------------------------------------
  // JIRA-011 — error messages NEVER include the apiToken
  // -------------------------------------------------------------------------
  it('JIRA-011: error messages NEVER include the apiToken (search 401)', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(401, { errorMessages: [TOKEN] }));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).not.toContain(TOKEN);
  });

  it('JIRA-011: error messages NEVER include the apiToken (search 429)', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(429, { msg: TOKEN }));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).not.toContain(TOKEN);
  });

  it('JIRA-011: error messages NEVER include the apiToken (search 500)', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, jsonStatus(500, { detail: TOKEN }));
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).not.toContain(TOKEN);
  });

  it('JIRA-011: error messages NEVER include the apiToken (network failure)', async () => {
    // Unmatched call → FakeHttpClient returns a NETWORK error which the
    // JiraClient must surface without leaking the token.
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NETWORK');
    expect(res.error.message).not.toContain(TOKEN);
  });

  it('JIRA-011: error messages NEVER include the apiToken (timeout)', async () => {
    http.expectPrefix('GET', SEARCH_PREFIX, {
      ok: false,
      error: { code: 'TIMEOUT', message: 'request timed out' },
    });
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('TIMEOUT');
    expect(res.error.message).not.toContain(TOKEN);
  });

  it('JIRA-011: error messages NEVER include the apiToken (malformed body)', async () => {
    http.expectPrefix(
      'GET',
      SEARCH_PREFIX,
      jsonOk(`garbage with ${TOKEN} embedded`),
    );
    const res = await client.search('project = "X"');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('INVALID_RESPONSE');
    expect(res.error.message).not.toContain(TOKEN);
  });

  it('JIRA-011: error messages NEVER include the apiToken (testConnection 401 echoing token)', async () => {
    http.expect('GET', MYSELF_URL, jsonStatus(401, { errorMessages: [`bad token: ${TOKEN}`] }));
    const res = await client.testConnection();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).not.toContain(TOKEN);
  });

  // -------------------------------------------------------------------------
  // JIRA-012 — issue with missing optional fields
  // -------------------------------------------------------------------------
  it('JIRA-012: issue with missing assignee + priority maps to safe defaults', async () => {
    const issue = fullIssue('ABC-99', {
      // Strip optional fields — Jira can omit these or send null.
      priority: null,
      assignee: null,
    });
    http.expectPrefix('GET', SEARCH_PREFIX, jsonOk(searchResponse([issue])));

    const res = await client.search('project = "ABC"');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tickets).toHaveLength(1);
    const t = res.data.tickets[0];
    expect(t).toBeDefined();
    if (!t) return;
    expect(t.key).toBe('ABC-99');
    expect(t.assignee).toBeNull();
    expect(t.priority).toBe('Unknown');
  });

  it('JIRA-012: malformed issue inside otherwise valid response is filtered out, not thrown', async () => {
    // Two issues — one valid, one missing key+fields entirely. The mapper
    // returns null for the bad one; client should drop it rather than crash.
    const issues = [fullIssue('ABC-1'), { not: 'an issue' }];
    http.expectPrefix('GET', SEARCH_PREFIX, jsonOk(searchResponse(issues, 2)));

    const res = await client.search('project = "ABC"');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // One valid ticket out; total reflects what Jira reported (2).
    expect(res.data.tickets).toHaveLength(1);
    expect(res.data.tickets[0]?.key).toBe('ABC-1');
  });
});
