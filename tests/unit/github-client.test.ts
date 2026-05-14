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
 * GH-CLIENT-001..012 — GithubClient unit tests.
 *
 * Mirrors `tests/unit/jira-client.test.ts`:
 *  - Fresh FakeHttpClient per test
 *  - Token NEVER appears in any error.message (security backstop)
 *
 * The token literal `ghp_secrettoken` is intentionally short and
 * recognizable so we can assert (via `JSON.stringify`) that it never
 * shows up in any returned `result.error` payload.
 */

const HOST = 'https://api.github.com';
const TOKEN = 'ghp_secrettoken';

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

const USER_URL = `${HOST}/user`;
const REPOS_URL_PREFIX = `${HOST}/user/repos`;

describe('GithubClient', () => {
  let http: FakeHttpClient;
  let client: GithubClient;

  beforeEach(() => {
    http = new FakeHttpClient();
    client = makeClient(http);
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-001 — testConnection() GETs /user with Bearer auth
  // -------------------------------------------------------------------------
  it('GH-CLIENT-001: testConnection() GETs `${host}/user` with Bearer auth + Accept + API-Version', async () => {
    http.expect(
      'GET',
      USER_URL,
      jsonResp({ login: 'gazhang', id: 42 }, 200, { 'X-OAuth-Scopes': 'repo, read:user' }),
    );

    const r = await client.testConnection();
    expect(r.ok).toBe(true);

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(USER_URL);

    // Authorization: Bearer <token>
    const headers = call.headers ?? {};
    const authH = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
    expect(authH).toBeDefined();
    expect(authH?.[1]).toBe(`Bearer ${TOKEN}`);

    // Accept: application/vnd.github+json
    const acceptH = Object.entries(headers).find(([k]) => k.toLowerCase() === 'accept');
    expect(acceptH).toBeDefined();
    expect(acceptH?.[1]).toBe('application/vnd.github+json');

    // X-GitHub-Api-Version: 2022-11-28
    const versionH = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === 'x-github-api-version',
    );
    expect(versionH).toBeDefined();
    expect(versionH?.[1]).toBe('2022-11-28');
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-002 — 200 → ok with login + scopes from X-OAuth-Scopes
  // -------------------------------------------------------------------------
  it('GH-CLIENT-002: 200 → ok with login + scopes parsed from X-OAuth-Scopes', async () => {
    http.expect(
      'GET',
      USER_URL,
      jsonResp(
        { login: 'gazhang', id: 42, name: 'Gary Zhang' },
        200,
        { 'X-OAuth-Scopes': 'repo, read:user, workflow' },
      ),
    );
    const r = await client.testConnection();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.login).toBe('gazhang');
    expect(r.data.id).toBe(42);
    expect(r.data.name).toBe('Gary Zhang');
    expect(r.data.scopes).toEqual(['repo', 'read:user', 'workflow']);
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-003 — 401/403 → AUTH
  // -------------------------------------------------------------------------
  it('GH-CLIENT-003: 401 → AUTH', async () => {
    http.expect('GET', USER_URL, jsonResp({ message: 'Bad credentials' }, 401));
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('AUTH');
    expect(r.error.status).toBe(401);
  });

  it('GH-CLIENT-003: 403 → AUTH', async () => {
    http.expect('GET', USER_URL, jsonResp({}, 403));
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('AUTH');
    expect(r.error.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-004 — 404 → NOT_FOUND
  // -------------------------------------------------------------------------
  it('GH-CLIENT-004: 404 → NOT_FOUND', async () => {
    http.expect('GET', USER_URL, jsonResp({}, 404));
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_FOUND');
    expect(r.error.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-005 — 429 → RATE_LIMITED
  // -------------------------------------------------------------------------
  it('GH-CLIENT-005: 429 → RATE_LIMITED', async () => {
    http.expect('GET', USER_URL, jsonResp({}, 429));
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('RATE_LIMITED');
    expect(r.error.status).toBe(429);
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-006 — 5xx → SERVER_ERROR
  // -------------------------------------------------------------------------
  it('GH-CLIENT-006: 500 → SERVER_ERROR', async () => {
    http.expect('GET', USER_URL, jsonResp({}, 500));
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SERVER_ERROR');
  });

  it('GH-CLIENT-006: 503 → SERVER_ERROR (any 5xx)', async () => {
    http.expect('GET', USER_URL, jsonResp({}, 503));
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SERVER_ERROR');
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-007 — Network / timeout / aborted
  // -------------------------------------------------------------------------
  it('GH-CLIENT-007: NETWORK at the http layer surfaces as NETWORK', async () => {
    // Unmatched call → FakeHttpClient returns a NETWORK error.
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NETWORK');
  });

  it('GH-CLIENT-007: TIMEOUT at the http layer surfaces as TIMEOUT', async () => {
    http.expect('GET', USER_URL, {
      ok: false,
      error: { code: 'TIMEOUT', message: 'request exceeded timeout' },
    });
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('TIMEOUT');
  });

  it('GH-CLIENT-007: ABORTED at the http layer surfaces as NETWORK or ABORTED', async () => {
    http.expect('GET', USER_URL, {
      ok: false,
      error: { code: 'ABORTED', message: 'aborted' },
    });
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Spec collapses ABORTED → NETWORK (matching JiraClient). Accept either
    // mapping in case Agent B keeps ABORTED as a first-class code.
    expect(['NETWORK', 'ABORTED']).toContain(r.error.code);
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-008 — listRepos returns mapped repo summaries
  // -------------------------------------------------------------------------
  it('GH-CLIENT-008: listRepos returns array of { fullName, defaultBranch, private }', async () => {
    const repos = [
      {
        full_name: 'gazhang/repo-a',
        default_branch: 'main',
        private: false,
        name: 'repo-a',
      },
      {
        full_name: 'gazhang/repo-b',
        default_branch: 'develop',
        private: true,
        name: 'repo-b',
      },
    ];
    http.expectPrefix('GET', REPOS_URL_PREFIX, jsonResp(repos));

    const r = await client.listRepos();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toEqual({
      fullName: 'gazhang/repo-a',
      defaultBranch: 'main',
      private: false,
    });
    expect(r.data[1]).toEqual({
      fullName: 'gazhang/repo-b',
      defaultBranch: 'develop',
      private: true,
    });
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-009 — listRepos honors per_page=100, sort=updated
  // -------------------------------------------------------------------------
  it('GH-CLIENT-009: listRepos URL contains per_page=100 and sort=updated', async () => {
    http.expectPrefix('GET', REPOS_URL_PREFIX, jsonResp([]));
    await client.listRepos();
    expect(http.calls).toHaveLength(1);
    const url = http.calls[0]?.url ?? '';
    expect(url).toContain('per_page=100');
    expect(url).toContain('sort=updated');
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-010 — token NEVER appears in any error.message
  // -------------------------------------------------------------------------
  describe('GH-CLIENT-010 token containment in errors', () => {
    it('GH-CLIENT-010: 401 echoing the token in body still produces a token-free error', async () => {
      http.expect(
        'GET',
        USER_URL,
        jsonResp({ message: `bad token: ${TOKEN}` }, 401),
      );
      const r = await client.testConnection();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-CLIENT-010: 500 echoing the token in body still produces a token-free error', async () => {
      http.expect('GET', USER_URL, jsonResp({ detail: TOKEN }, 500));
      const r = await client.testConnection();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-CLIENT-010: 429 echoing the token still produces a token-free error', async () => {
      http.expect('GET', USER_URL, jsonResp({ msg: TOKEN }, 429));
      const r = await client.testConnection();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-CLIENT-010: NETWORK error does NOT leak the token', async () => {
      // Unmatched call → NETWORK
      const r = await client.testConnection();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-CLIENT-010: malformed JSON body containing the token does NOT leak it', async () => {
      http.expect(
        'GET',
        USER_URL,
        jsonResp(`garbage with ${TOKEN} inside it`, 200),
      );
      const r = await client.testConnection();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INVALID_RESPONSE');
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-CLIENT-010: listRepos errors also do NOT leak the token', async () => {
      http.expectPrefix(
        'GET',
        REPOS_URL_PREFIX,
        jsonResp({ message: TOKEN }, 500),
      );
      const r = await client.listRepos();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-011 — missing X-OAuth-Scopes → scopes = []
  // -------------------------------------------------------------------------
  it('GH-CLIENT-011: missing X-OAuth-Scopes → scopes is an empty array', async () => {
    http.expect(
      'GET',
      USER_URL,
      jsonResp({ login: 'gazhang', id: 42 }, 200), // no X-OAuth-Scopes header
    );
    const r = await client.testConnection();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.scopes).toEqual([]);
  });

  it('GH-CLIENT-011: empty X-OAuth-Scopes header → scopes is an empty array', async () => {
    http.expect(
      'GET',
      USER_URL,
      jsonResp({ login: 'gazhang', id: 42 }, 200, { 'X-OAuth-Scopes': '' }),
    );
    const r = await client.testConnection();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.scopes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // GH-CLIENT-012 — garbage JSON body → INVALID_RESPONSE
  // -------------------------------------------------------------------------
  it('GH-CLIENT-012: 200 with garbage body → INVALID_RESPONSE', async () => {
    http.expect('GET', USER_URL, jsonResp('{ this is not { valid json', 200));
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INVALID_RESPONSE');
  });

  // -------------------------------------------------------------------------
  // BRANCH-001..003 — listBranches(slug) (issue #25 polish)
  //
  // Spec:
  //   - URL: `${host}/repos/${slug}/branches?per_page=100`
  //   - Returns array of `{ name: string; protected: boolean }`
  //   - Same security rules: token never in error.message
  //   - Same status mapping as listRepos / testConnection (401/403→AUTH, etc)
  // -------------------------------------------------------------------------
  describe('BRANCH-001..003 listBranches()', () => {
    const SLUG = 'gazhang/foo';
    const BRANCHES_URL_PREFIX = `${HOST}/repos/${SLUG}/branches`;

    it('BRANCH-001: GETs `${host}/repos/{slug}/branches?per_page=100`', async () => {
      http.expectPrefix('GET', BRANCHES_URL_PREFIX, jsonResp([]));

      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(true);

      expect(http.calls).toHaveLength(1);
      const url = http.calls[0]?.url ?? '';
      expect(url.startsWith(BRANCHES_URL_PREFIX)).toBe(true);
      expect(url).toContain('per_page=100');
    });

    it('BRANCH-001: every request carries the same Bearer auth + Accept + version headers', async () => {
      http.expectPrefix('GET', BRANCHES_URL_PREFIX, jsonResp([]));
      await client.listBranches(SLUG);

      const headers = http.calls[0]?.headers ?? {};
      const authH = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
      expect(authH?.[1]).toBe(`Bearer ${TOKEN}`);
      const acceptH = Object.entries(headers).find(([k]) => k.toLowerCase() === 'accept');
      expect(acceptH?.[1]).toBe('application/vnd.github+json');
      const versionH = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === 'x-github-api-version',
      );
      expect(versionH?.[1]).toBe('2022-11-28');
    });

    it('BRANCH-002: 200 → array of `{ name, protected }` (only those two fields kept)', async () => {
      const branches = [
        { name: 'main', protected: true, commit: { sha: 'aaa' } },
        { name: 'develop', protected: false, commit: { sha: 'bbb' } },
        { name: 'feature/xyz', protected: false, commit: { sha: 'ccc' } },
      ];
      http.expectPrefix('GET', BRANCHES_URL_PREFIX, jsonResp(branches));

      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toHaveLength(3);
      expect(r.data[0]).toEqual({ name: 'main', protected: true });
      expect(r.data[1]).toEqual({ name: 'develop', protected: false });
      expect(r.data[2]).toEqual({ name: 'feature/xyz', protected: false });
    });

    it('BRANCH-002: malformed entries are dropped (not thrown)', async () => {
      const branches = [
        { name: 'main', protected: true },
        { name: 42, protected: true }, // bad name type
        { protected: true }, // missing name
        { name: 'develop' /* missing protected */ },
        'not-an-object',
      ];
      http.expectPrefix('GET', BRANCHES_URL_PREFIX, jsonResp(branches));

      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Only the well-formed entry survives.
      expect(r.data).toEqual([{ name: 'main', protected: true }]);
    });

    it('BRANCH-002: 401 → AUTH', async () => {
      http.expectPrefix('GET', BRANCHES_URL_PREFIX, jsonResp({}, 401));
      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('AUTH');
      expect(r.error.status).toBe(401);
    });

    it('BRANCH-002: 404 → NOT_FOUND', async () => {
      http.expectPrefix('GET', BRANCHES_URL_PREFIX, jsonResp({}, 404));
      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_FOUND');
    });

    it('BRANCH-002: 500 → SERVER_ERROR', async () => {
      http.expectPrefix('GET', BRANCHES_URL_PREFIX, jsonResp({}, 500));
      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('SERVER_ERROR');
    });

    it('BRANCH-003: token NEVER appears in error.message (401 echoing token)', async () => {
      http.expectPrefix(
        'GET',
        BRANCHES_URL_PREFIX,
        jsonResp({ message: `bad token: ${TOKEN}` }, 401),
      );
      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('BRANCH-003: token NEVER appears in error.message (5xx with token in body)', async () => {
      http.expectPrefix(
        'GET',
        BRANCHES_URL_PREFIX,
        jsonResp({ detail: TOKEN }, 500),
      );
      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('BRANCH-003: NETWORK error does NOT leak the token', async () => {
      // Unmatched call → FakeHttpClient returns NETWORK
      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('BRANCH-003: malformed body containing the token does NOT leak it', async () => {
      http.expectPrefix(
        'GET',
        BRANCHES_URL_PREFIX,
        jsonResp(`garbage with ${TOKEN} embedded`, 200),
      );
      const r = await client.listBranches(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INVALID_RESPONSE');
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
  });

  // ===========================================================================
  // GH-CLIENT-PULL-001..006 — listPullRequests via GraphQL (issue #GH-67)
  // ===========================================================================
  //
  // listPullRequests posts a single GraphQL query to `${host}/graphql` and
  // returns mapped GithubPullSummary[]. Same security invariant as the REST
  // methods: the token must NEVER appear in any error.

  describe('listPullRequests (GraphQL) — #GH-67', () => {
    const SLUG = 'gazhang/repo-a';
    const GRAPHQL_URL = `${HOST}/graphql`;

    function gqlOk(nodes: unknown[], status = 200, headers: Record<string, string> = {}) {
      return jsonResp({ data: { repository: { pullRequests: { nodes } } } }, status, headers);
    }

    it('GH-CLIENT-PULL-001: POSTs to /graphql with Bearer auth + JSON body', async () => {
      http.expect('POST', GRAPHQL_URL, gqlOk([]));
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(true);
      expect(http.calls).toHaveLength(1);
      const call = http.calls[0]!;
      expect(call.method).toBe('POST');
      expect(call.url).toBe(GRAPHQL_URL);
      // Auth + content-type
      const headers = call.headers ?? {};
      const authH = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization');
      expect(authH?.[1]).toBe(`Bearer ${TOKEN}`);
      const ctH = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type');
      expect(ctH?.[1]).toBe('application/json');
      // Body shape — query string + variables
      const body = JSON.parse(call.body ?? '{}');
      expect(typeof body.query).toBe('string');
      expect(body.query).toContain('pullRequests(first: 50');
      expect(body.variables).toEqual({ owner: 'gazhang', name: 'repo-a' });
    });

    it('GH-CLIENT-PULL-002: maps nodes to GithubPullSummary[]', async () => {
      const nodes = [
        {
          number: 42,
          title: 'Add PRs tab',
          author: { login: 'gazhang' },
          state: 'OPEN',
          isDraft: false,
          reviewDecision: 'APPROVED',
          mergedAt: null,
          closedAt: null,
          updatedAt: '2026-05-12T10:00:00Z',
          url: 'https://github.com/gazhang/repo-a/pull/42',
        },
        {
          number: 41,
          title: 'WIP: refactor',
          author: { login: 'gazhang' },
          state: 'OPEN',
          isDraft: true,
          reviewDecision: null,
          mergedAt: null,
          closedAt: null,
          updatedAt: '2026-05-11T10:00:00Z',
          url: 'https://github.com/gazhang/repo-a/pull/41',
        },
        {
          number: 40,
          title: 'Old merged thing',
          author: { login: 'dependabot' },
          state: 'MERGED',
          isDraft: false,
          reviewDecision: 'APPROVED',
          mergedAt: '2026-05-09T10:00:00Z',
          closedAt: '2026-05-09T10:00:00Z',
          updatedAt: '2026-05-09T10:00:00Z',
          url: 'https://github.com/gazhang/repo-a/pull/40',
        },
      ];
      http.expect('POST', GRAPHQL_URL, gqlOk(nodes));
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toHaveLength(3);
      expect(r.data[0]).toEqual({
        number: 42,
        title: 'Add PRs tab',
        authorLogin: 'gazhang',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'APPROVED',
        mergedAt: null,
        closedAt: null,
        updatedAt: '2026-05-12T10:00:00Z',
        url: 'https://github.com/gazhang/repo-a/pull/42',
      });
      expect(r.data[1]?.isDraft).toBe(true);
      expect(r.data[1]?.reviewDecision).toBeNull();
      expect(r.data[2]?.state).toBe('MERGED');
    });

    it('GH-CLIENT-PULL-003: tolerates null author (deleted account)', async () => {
      const nodes = [
        {
          number: 7,
          title: 'Ghost PR',
          author: null,
          state: 'OPEN',
          isDraft: false,
          reviewDecision: null,
          mergedAt: null,
          closedAt: null,
          updatedAt: '2026-05-10T10:00:00Z',
          url: 'https://github.com/gazhang/repo-a/pull/7',
        },
      ];
      http.expect('POST', GRAPHQL_URL, gqlOk(nodes));
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data[0]?.authorLogin).toBeNull();
    });

    it('GH-CLIENT-PULL-004: 401 → AUTH', async () => {
      http.expect('POST', GRAPHQL_URL, jsonResp({ message: 'Bad credentials' }, 401));
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('AUTH');
    });

    it('GH-CLIENT-PULL-005a: REST-style 403 with X-RateLimit-Remaining: 0 → RATE_LIMITED with reset time', async () => {
      const resetSeconds = Math.floor(Date.now() / 1000) + 600;
      http.expect(
        'POST',
        GRAPHQL_URL,
        jsonResp({}, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetSeconds),
        }),
      );
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('RATE_LIMITED');
      // Reset time is folded into the message as ISO so the renderer can show it.
      expect(r.error.message).toMatch(/Resets at \d{4}-\d{2}-\d{2}T/);
    });

    it('GH-CLIENT-PULL-005a2: secondary rate limit (403 + Retry-After header, no X-RateLimit-Remaining) → RATE_LIMITED', async () => {
      http.expect(
        'POST',
        GRAPHQL_URL,
        jsonResp({}, 403, { 'retry-after': '60' }),
      );
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // Must NOT be classified as AUTH — that would surface the wrong banner.
      expect(r.error.code).toBe('RATE_LIMITED');
      expect(r.error.message).toMatch(/secondary rate limit/i);
      expect(r.error.message).toMatch(/60s/);
    });

    it('GH-CLIENT-PULL-005b: GraphQL errors[].type === RATE_LIMITED → RATE_LIMITED', async () => {
      http.expect(
        'POST',
        GRAPHQL_URL,
        jsonResp(
          {
            data: null,
            errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
          },
          200,
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' },
        ),
      );
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('RATE_LIMITED');
    });

    it('GH-CLIENT-PULL-005c: non-rate-limit GraphQL errors → INVALID_RESPONSE', async () => {
      http.expect(
        'POST',
        GRAPHQL_URL,
        jsonResp({ errors: [{ type: 'NOT_FOUND', message: "Could not resolve to a Repository" }] }),
      );
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INVALID_RESPONSE');
    });

    it('GH-CLIENT-PULL-005d: repository: null in GraphQL data → NOT_FOUND', async () => {
      http.expect('POST', GRAPHQL_URL, jsonResp({ data: { repository: null } }));
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_FOUND');
    });

    it('GH-CLIENT-PULL-006: token NEVER appears in any error path', async () => {
      // Echo the token in the response body to make sure no error message leaks it.
      http.expect('POST', GRAPHQL_URL, jsonResp({ message: `bad: ${TOKEN}` }, 401));
      const r = await client.listPullRequests(SLUG);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });

    it('GH-CLIENT-PULL-006: invalid slug → INVALID_RESPONSE without making an HTTP call', async () => {
      const r = await client.listPullRequests('no-slash');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('INVALID_RESPONSE');
      expect(http.calls).toHaveLength(0);
    });

    // GH-CLIENT-PULL-007 — Enterprise host translates `/api/v3` → `/api/graphql`
    // (NOT `/api/v3/graphql` which would 404 against GHE).
    it('GH-CLIENT-PULL-007: enterprise host (…/api/v3) posts GraphQL to …/api/graphql', async () => {
      const enterpriseHost = 'https://ghes.example.com/api/v3';
      const enterpriseClient = new GithubClient({
        httpClient: http,
        host: enterpriseHost,
        auth: auth(),
      });
      const expectedGraphqlUrl = 'https://ghes.example.com/api/graphql';
      http.expect(
        'POST',
        expectedGraphqlUrl,
        jsonResp({ data: { repository: { pullRequests: { nodes: [] } } } }),
      );
      const r = await enterpriseClient.listPullRequests(SLUG);
      expect(r.ok).toBe(true);
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]?.url).toBe(expectedGraphqlUrl);
    });
  });
});
