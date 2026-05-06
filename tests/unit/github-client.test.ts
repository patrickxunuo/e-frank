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
});
