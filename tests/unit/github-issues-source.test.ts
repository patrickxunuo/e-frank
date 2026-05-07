import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeHttpClient,
  type HttpResult,
} from '../../src/main/modules/http-client';
import {
  GithubClient,
  type GithubAuth,
} from '../../src/main/modules/github-client';

/**
 * GH-ISSUES-CLIENT-001..003 — `GithubClient.listIssues(slug, opts)`.
 *
 * Spec:
 *  - URL: `${host}/repos/${slug}/issues?state=${state ?? 'open'}&per_page=${perPage ?? 100}${labels ? `&labels=${encodeURIComponent(labels)}` : ''}`
 *  - Returns the raw GitHub issue array (mapper happens elsewhere).
 *  - Token NEVER appears in error.message (security backstop, same rule as
 *    every other GithubClient method).
 *
 * Tests mirror `github-client.test.ts`'s `listRepos` block.
 */

const HOST = 'https://api.github.com';
const TOKEN = 'ghp_secrettoken';
const SLUG = 'gazhang/foo';

function auth(): GithubAuth {
  return { token: TOKEN };
}

function makeClient(http: FakeHttpClient): GithubClient {
  return new GithubClient({ httpClient: http, host: HOST, auth: auth() });
}

function jsonResp(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): HttpResult {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  };
}

const ISSUES_URL_PREFIX = `${HOST}/repos/${SLUG}/issues`;

describe('GithubClient.listIssues — GH-ISSUES-CLIENT', () => {
  let http: FakeHttpClient;
  let client: GithubClient;

  beforeEach(() => {
    http = new FakeHttpClient();
    client = makeClient(http);
  });

  // -------------------------------------------------------------------------
  // GH-ISSUES-CLIENT-001 — URL shape: state=open, per_page=100 by default
  // -------------------------------------------------------------------------
  it('GH-ISSUES-CLIENT-001: GETs /repos/{slug}/issues?state=open&per_page=100 by default', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp([]));

    const r = await client.listIssues(SLUG, {});
    expect(r.ok).toBe(true);

    expect(http.calls).toHaveLength(1);
    const url = http.calls[0]?.url ?? '';
    expect(url.startsWith(ISSUES_URL_PREFIX)).toBe(true);
    expect(url).toContain('state=open');
    expect(url).toContain('per_page=100');
  });

  it('GH-ISSUES-CLIENT-001: explicit `state` and `perPage` flow into the URL', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp([]));

    await client.listIssues(SLUG, { state: 'closed', perPage: 50 });

    const url = http.calls[0]?.url ?? '';
    expect(url).toContain('state=closed');
    expect(url).toContain('per_page=50');
  });

  it('GH-ISSUES-CLIENT-001: state=all is honored', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp([]));
    await client.listIssues(SLUG, { state: 'all' });
    const url = http.calls[0]?.url ?? '';
    expect(url).toContain('state=all');
  });

  it('GH-ISSUES-CLIENT-001: 200 returns the raw issue array (no mapping)', async () => {
    const raw = [
      {
        number: 1,
        title: 'A',
        state: 'open',
        html_url: 'https://github.com/gazhang/foo/issues/1',
        updated_at: '2026-05-05T10:00:00Z',
        labels: [],
        assignee: null,
      },
      {
        number: 2,
        title: 'B',
        state: 'open',
        html_url: 'https://github.com/gazhang/foo/issues/2',
        updated_at: '2026-05-05T11:00:00Z',
        labels: [],
        assignee: null,
        pull_request: { url: 'https://api.github.com/...' },
      },
    ];
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp(raw));

    const r = await client.listIssues(SLUG, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The client returns the RAW array — PR filtering is the source
    // strategy's job, not the client's.
    expect(Array.isArray(r.data)).toBe(true);
    expect(r.data).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // GH-ISSUES-CLIENT-002 — `labels` opt URL-encoded into the query string
  // -------------------------------------------------------------------------
  it('GH-ISSUES-CLIENT-002: labels opt URL-encoded into the query string', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp([]));
    await client.listIssues(SLUG, { labels: 'bug,enhancement' });

    const url = http.calls[0]?.url ?? '';
    // encodeURIComponent('bug,enhancement') === 'bug%2Cenhancement'
    expect(url).toContain('labels=bug%2Cenhancement');
    // Single-encoded — no '%252' artifacts.
    expect(url).not.toContain('%252');
  });

  it('GH-ISSUES-CLIENT-002: labels with special chars (spaces, slashes) URL-encoded', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp([]));
    await client.listIssues(SLUG, { labels: 'priority/high,needs review' });

    const url = http.calls[0]?.url ?? '';
    expect(url).toContain(`labels=${encodeURIComponent('priority/high,needs review')}`);
  });

  it('GH-ISSUES-CLIENT-002: omitted labels → no labels= query param', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp([]));
    await client.listIssues(SLUG, {});
    const url = http.calls[0]?.url ?? '';
    expect(url).not.toContain('labels=');
  });

  // -------------------------------------------------------------------------
  // GH-ISSUES-CLIENT-003 — Token NEVER appears in error.message
  // -------------------------------------------------------------------------
  describe('GH-ISSUES-CLIENT-003 token containment in errors', () => {
    it('GH-ISSUES-CLIENT-003: 401 echoing the token still produces a token-free error', async () => {
      http.expectPrefix(
        'GET',
        ISSUES_URL_PREFIX,
        jsonResp({ message: `bad token: ${TOKEN}` }, 401),
      );
      const r = await client.listIssues(SLUG, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-ISSUES-CLIENT-003: 500 with token in body → token-free error', async () => {
      http.expectPrefix(
        'GET',
        ISSUES_URL_PREFIX,
        jsonResp({ detail: TOKEN }, 500),
      );
      const r = await client.listIssues(SLUG, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-ISSUES-CLIENT-003: 429 with token echoed → token-free error', async () => {
      http.expectPrefix(
        'GET',
        ISSUES_URL_PREFIX,
        jsonResp({ msg: TOKEN }, 429),
      );
      const r = await client.listIssues(SLUG, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-ISSUES-CLIENT-003: NETWORK error → token-free', async () => {
      // Unmatched call → FakeHttpClient returns a NETWORK error.
      const r = await client.listIssues(SLUG, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-ISSUES-CLIENT-003: malformed body containing the token does NOT leak it', async () => {
      http.expectPrefix(
        'GET',
        ISSUES_URL_PREFIX,
        jsonResp(`garbage with ${TOKEN} embedded`, 200),
      );
      const r = await client.listIssues(SLUG, {});
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INVALID_RESPONSE');
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // Status mapping regressions (mirror listRepos behaviour)
  // -------------------------------------------------------------------------
  it('listIssues maps status codes the same way as listRepos (401 → AUTH)', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp({}, 401));
    const r = await client.listIssues(SLUG, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('AUTH');
    expect(r.error.status).toBe(401);
  });

  it('listIssues maps 404 → NOT_FOUND', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp({}, 404));
    const r = await client.listIssues(SLUG, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
  });

  it('listIssues maps 429 → RATE_LIMITED', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp({}, 429));
    const r = await client.listIssues(SLUG, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('RATE_LIMITED');
  });

  it('listIssues maps 500 → SERVER_ERROR', async () => {
    http.expectPrefix('GET', ISSUES_URL_PREFIX, jsonResp({}, 500));
    const r = await client.listIssues(SLUG, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SERVER_ERROR');
  });
});
