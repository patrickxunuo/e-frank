/**
 * `SkillsSearchClient` — typed wrapper around the skills.sh public search
 * REST API. Replaces the SkillFinder Claude-subprocess pipeline (#GH-93).
 *
 * Endpoint:
 *   GET https://www.skills.sh/api/search?q=<encoded>&limit=<N>
 *
 * Unauthenticated. Response shape (verified against the live API):
 *   {
 *     query: string,
 *     searchType: 'fuzzy' | 'exact',
 *     skills: ApiSkill[],
 *     count: number,
 *     duration_ms: number,
 *   }
 *
 * All HTTP goes through an injected `HttpClient` so this module is
 * unit-testable with `FakeHttpClient`. Mirrors the JiraClient pattern —
 * sanitized error taxonomy, never leaks the query string in error
 * messages (defense-in-depth even though the query is user-typed and
 * lowly sensitive).
 */

import type { HttpClient, HttpRequest } from './http-client.js';

export const SKILLS_SEARCH_BASE_URL = 'https://www.skills.sh/api/search';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Renderer-facing record for one skills.sh result row. Field names mirror
 * the API exactly so the renderer can render without a translation layer.
 */
export interface ApiSkill {
  /** Full path like `vercel-labs/agent-skills/web-design-guidelines`. */
  id: string;
  /** Bare slug like `web-design-guidelines`. This is the `npx skills add`
   *  ref AND the local folder basename — used to dedupe against installed. */
  skillId: string;
  /** Display name (frequently equal to skillId). */
  name: string;
  /** Cumulative install count from the registry. */
  installs: number;
  /** Source slug like `vercel-labs/agent-skills`. */
  source: string;
}

export interface SkillsSearchOptions {
  /** Query text (URL-encoded by the client; pass raw user input here). */
  query: string;
  /** Cap on returned rows. Currently we re-request with a growing limit
   *  to page; capped at 200 in the renderer. */
  limit: number;
}

export interface SkillsSearchResponse {
  skills: ApiSkill[];
  /** Total matches the API knows about. Used to decide whether to keep paging. */
  count: number;
}

export type SkillsSearchErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE'
  | 'INVALID_REQUEST';

export type SkillsSearchResult =
  | { ok: true; data: SkillsSearchResponse }
  | {
      ok: false;
      error: { code: SkillsSearchErrorCode; message: string; status?: number };
    };

export interface SkillsSearchClientOptions {
  httpClient: HttpClient;
  /** Override base URL for tests. Defaults to the production endpoint. */
  baseUrl?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function statusToCode(status: number): SkillsSearchErrorCode {
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status < 600) return 'SERVER_ERROR';
  return 'INVALID_RESPONSE';
}

function parseSkillEntry(raw: unknown): ApiSkill | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw['id'] === 'string' ? raw['id'] : null;
  const skillId = typeof raw['skillId'] === 'string' ? raw['skillId'] : null;
  const name = typeof raw['name'] === 'string' ? raw['name'] : null;
  const installs = typeof raw['installs'] === 'number' && Number.isFinite(raw['installs'])
    ? Math.max(0, Math.floor(raw['installs']))
    : null;
  const source = typeof raw['source'] === 'string' ? raw['source'] : null;
  if (id === null || skillId === null || name === null || installs === null || source === null) {
    return null;
  }
  return { id, skillId, name, installs, source };
}

export class SkillsSearchClient {
  private readonly httpClient: HttpClient;
  private readonly baseUrl: string;

  constructor(opts: SkillsSearchClientOptions) {
    this.httpClient = opts.httpClient;
    this.baseUrl = opts.baseUrl ?? SKILLS_SEARCH_BASE_URL;
  }

  async search(opts: SkillsSearchOptions): Promise<SkillsSearchResult> {
    const query = opts.query.trim();
    if (query === '') {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'query must be a non-empty string' },
      };
    }
    if (!Number.isFinite(opts.limit) || opts.limit <= 0) {
      return {
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'limit must be a positive integer' },
      };
    }
    const limit = Math.floor(opts.limit);
    const url = `${this.baseUrl}?q=${encodeURIComponent(query)}&limit=${limit}`;
    const req: HttpRequest = {
      method: 'GET',
      url,
      headers: { Accept: 'application/json' },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };

    const res = await this.httpClient.request(req);
    if (!res.ok) {
      // Map low-level HttpClient codes onto our taxonomy. Never echo the
      // underlying error message — defense-in-depth so a future fetch()
      // regression can't leak request URL or query into our errors.
      if (res.error.code === 'TIMEOUT') {
        return { ok: false, error: { code: 'TIMEOUT', message: 'skills.sh request timed out' } };
      }
      return {
        ok: false,
        error: { code: 'NETWORK', message: 'skills.sh request failed' },
      };
    }

    const { response } = res;
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        error: {
          code: statusToCode(response.status),
          message: `skills.sh returned HTTP ${response.status}`,
          status: response.status,
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'skills.sh returned non-JSON body' },
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'skills.sh body was not an object' },
      };
    }
    const rawSkills = parsed['skills'];
    if (!Array.isArray(rawSkills)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'skills.sh body missing skills array' },
      };
    }
    const rawCount = parsed['count'];
    // Count is informational — when the API omits it we fall back to the
    // returned-array length. Pagination keeps working either way.
    const count = typeof rawCount === 'number' && Number.isFinite(rawCount)
      ? Math.max(0, Math.floor(rawCount))
      : rawSkills.length;

    const skills: ApiSkill[] = [];
    for (const entry of rawSkills) {
      const parsedEntry = parseSkillEntry(entry);
      if (parsedEntry !== null) skills.push(parsedEntry);
    }

    return { ok: true, data: { skills, count } };
  }
}
