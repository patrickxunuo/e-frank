import { describe, it, expect, beforeEach } from 'vitest';
import { FakeHttpClient, type HttpResult } from '../../src/main/modules/http-client';
import {
  SkillsSearchClient,
  SKILLS_SEARCH_BASE_URL,
  type ApiSkill,
} from '../../src/main/modules/skills-search-client';

/**
 * SkillsSearchClient acceptance tests (SEARCH-001 .. SEARCH-014).
 *
 * Every test constructs a fresh client over a FakeHttpClient so no real
 * skills.sh host is contacted. SEARCH-012 is the leak backstop: the query
 * literal must NEVER appear inside any error.message returned by the client.
 */

function makeClient(http: FakeHttpClient): SkillsSearchClient {
  return new SkillsSearchClient({ httpClient: http });
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

function networkFail(): HttpResult {
  return { ok: false, error: { code: 'NETWORK', message: 'getaddrinfo ENOTFOUND' } };
}

function timeoutFail(): HttpResult {
  return { ok: false, error: { code: 'TIMEOUT', message: 'request exceeded 10000ms' } };
}

function apiSkillResponse(skills: unknown[], count?: number): unknown {
  return {
    query: 'ui',
    searchType: 'fuzzy',
    skills,
    count: count ?? skills.length,
    duration_ms: 90,
  };
}

const SAMPLE_ROW: ApiSkill = {
  id: 'vercel-labs/agent-skills/web-design-guidelines',
  skillId: 'web-design-guidelines',
  name: 'web-design-guidelines',
  installs: 320851,
  source: 'vercel-labs/agent-skills',
};

describe('SkillsSearchClient (GH-93)', () => {
  let http: FakeHttpClient;
  let client: SkillsSearchClient;

  beforeEach(() => {
    http = new FakeHttpClient();
    client = makeClient(http);
  });

  // -- SEARCH-001 — happy path: URL shape + payload mapping ------------------
  it('SEARCH-001: GETs the search endpoint with URL-encoded query + limit', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonOk(apiSkillResponse([SAMPLE_ROW])));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.data.skills).toEqual([SAMPLE_ROW]);
    expect(res.data.count).toBe(1);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.method).toBe('GET');
    expect(http.calls[0]?.url).toBe(`${SKILLS_SEARCH_BASE_URL}?q=ui&limit=20`);
    expect(http.calls[0]?.headers?.['Accept']).toBe('application/json');
    expect(http.calls[0]?.timeoutMs).toBe(10_000);
  });

  it('SEARCH-002: URL-encodes special characters in the query', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonOk(apiSkillResponse([])));
    await client.search({ query: 'create jira ticket & more', limit: 40 });
    expect(http.calls[0]?.url).toBe(
      `${SKILLS_SEARCH_BASE_URL}?q=create%20jira%20ticket%20%26%20more&limit=40`,
    );
  });

  it('SEARCH-003: trims whitespace from the query before encoding', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonOk(apiSkillResponse([])));
    await client.search({ query: '  ui  ', limit: 20 });
    expect(http.calls[0]?.url).toBe(`${SKILLS_SEARCH_BASE_URL}?q=ui&limit=20`);
  });

  it('SEARCH-004: rejects empty/whitespace-only query without making a call', async () => {
    const empty = await client.search({ query: '', limit: 20 });
    const ws = await client.search({ query: '   ', limit: 20 });
    expect(empty.ok).toBe(false);
    expect(ws.ok).toBe(false);
    if (empty.ok || ws.ok) throw new Error('expected error');
    expect(empty.error.code).toBe('INVALID_REQUEST');
    expect(ws.error.code).toBe('INVALID_REQUEST');
    expect(http.calls).toHaveLength(0);
  });

  it('SEARCH-005: rejects non-positive limit without making a call', async () => {
    const zero = await client.search({ query: 'ui', limit: 0 });
    const neg = await client.search({ query: 'ui', limit: -5 });
    const nan = await client.search({ query: 'ui', limit: Number.NaN });
    expect(zero.ok).toBe(false);
    expect(neg.ok).toBe(false);
    expect(nan.ok).toBe(false);
    if (zero.ok || neg.ok || nan.ok) throw new Error('expected error');
    expect(zero.error.code).toBe('INVALID_REQUEST');
    expect(neg.error.code).toBe('INVALID_REQUEST');
    expect(nan.error.code).toBe('INVALID_REQUEST');
    expect(http.calls).toHaveLength(0);
  });

  // -- SEARCH-006 — error mappings ----------------------------------------
  it('SEARCH-006: NETWORK error from HttpClient → NETWORK', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, networkFail());
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('NETWORK');
  });

  it('SEARCH-007: TIMEOUT error from HttpClient → TIMEOUT', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, timeoutFail());
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('TIMEOUT');
  });

  it('SEARCH-008: HTTP 429 → RATE_LIMITED with status echo', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonStatus(429, { error: 'rate limit' }));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('RATE_LIMITED');
    expect(res.error.status).toBe(429);
  });

  it('SEARCH-009: HTTP 5xx → SERVER_ERROR with status echo', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonStatus(503, { error: 'down' }));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('SERVER_ERROR');
    expect(res.error.status).toBe(503);
  });

  it('SEARCH-010: HTTP 4xx (non-429) → INVALID_RESPONSE', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonStatus(400, { error: 'bad request' }));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('INVALID_RESPONSE');
    expect(res.error.status).toBe(400);
  });

  it('SEARCH-011: non-JSON body → INVALID_RESPONSE', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonOk('<html>not json</html>'));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('INVALID_RESPONSE');
  });

  it('SEARCH-011b: body missing skills array → INVALID_RESPONSE', async () => {
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonOk({ count: 0 }));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected error');
    expect(res.error.code).toBe('INVALID_RESPONSE');
  });

  // -- SEARCH-012 — security: query/url never echoed in error.message ----
  it('SEARCH-012: query literal never leaked in error.message across all paths', async () => {
    const SECRET = 'top-secret-query-needle';
    const cases: HttpResult[] = [
      networkFail(),
      timeoutFail(),
      jsonStatus(429),
      jsonStatus(503),
      jsonStatus(400),
      jsonOk('not json'),
      jsonOk({ count: 0 }),
    ];
    for (const fixture of cases) {
      http.reset();
      http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, fixture);
      const res = await client.search({ query: SECRET, limit: 20 });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected error');
      expect(res.error.message).not.toContain(SECRET);
    }
  });

  // -- SEARCH-013 — defensive parsing -------------------------------------
  it('SEARCH-013: drops malformed skill entries; keeps well-formed ones', async () => {
    const body = apiSkillResponse(
      [
        SAMPLE_ROW,
        { id: 'a/b/c', skillId: 'c', name: 'c', installs: 'oops', source: 'a/b' }, // installs not number
        { id: 'd/e/f', skillId: 'f', name: 'f', source: 'd/e' }, // missing installs
        null, // entirely garbage
        'not an object',
        { ...SAMPLE_ROW, id: 'second/path/another', skillId: 'another', name: 'another' },
      ],
      6,
    );
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonOk(body));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.data.skills).toHaveLength(2);
    expect(res.data.skills[0]).toEqual(SAMPLE_ROW);
    expect(res.data.skills[1]?.skillId).toBe('another');
    // Count is what the API said, not the post-filter length.
    expect(res.data.count).toBe(6);
  });

  it('SEARCH-013b: missing count field falls back to skills array length', async () => {
    const body = {
      query: 'ui',
      searchType: 'fuzzy',
      skills: [SAMPLE_ROW],
      duration_ms: 90,
    };
    http.expectPrefix('GET', SKILLS_SEARCH_BASE_URL, jsonOk(body));
    const res = await client.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.data.count).toBe(1);
  });

  it('SEARCH-014: allows custom baseUrl injection for tests', async () => {
    const custom = new SkillsSearchClient({
      httpClient: http,
      baseUrl: 'https://staging.skills.sh/api/search',
    });
    http.expectPrefix('GET', 'https://staging.skills.sh/api/search', jsonOk(apiSkillResponse([])));
    const res = await custom.search({ query: 'ui', limit: 20 });
    expect(res.ok).toBe(true);
    expect(http.calls[0]?.url).toBe(
      'https://staging.skills.sh/api/search?q=ui&limit=20',
    );
  });
});
