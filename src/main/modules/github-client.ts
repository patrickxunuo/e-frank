/**
 * `GithubClient` — minimal typed wrapper over GitHub's REST API. Two
 * endpoints for now: `/user` (test connection + scopes) and `/user/repos`
 * (list repos). All HTTP goes through an injected `HttpClient` so this
 * module is unit-testable with `FakeHttpClient`.
 *
 * Security invariant: the `token` MUST NEVER appear in any error message,
 * thrown error, or log line — same rule as `JiraClient`. Every error path
 * here is sanitized; we propagate codes and short, fixed messages, never
 * the underlying `error.message` from the network layer.
 */

import type { HttpClient, HttpRequest, HttpResult } from './http-client.js';

export interface GithubAuth {
  /** PAT (`ghp_...`, `github_pat_...`) or OAuth token. NEVER logged. */
  token: string;
}

export interface GithubClientOptions {
  httpClient: HttpClient;
  /** Base URL like 'https://api.github.com' — no trailing slash. */
  host: string;
  auth: GithubAuth;
}

export type GithubErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE';

export type GithubResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: GithubErrorCode; message: string; status?: number } };

export interface GithubUser {
  login: string;
  id: number;
  name?: string;
  /** OAuth scopes from the `X-OAuth-Scopes` response header (comma-separated, trimmed). Empty array if missing. */
  scopes: string[];
}

export interface GithubRepoSummary {
  fullName: string; // "owner/name"
  defaultBranch: string;
  private: boolean;
}

export interface GithubBranchSummary {
  name: string;
  protected: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Translate an HTTP `status` to a `GithubErrorCode`. Same mapping as
 * `JiraClient` — kept identical so the renderer's error display can be
 * provider-agnostic.
 */
function statusToGithubCode(status: number): GithubErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status < 600) return 'SERVER_ERROR';
  return 'INVALID_RESPONSE';
}

/**
 * Lift an `HttpResult` low-level error into a sanitized GithubResult error.
 * Like `JiraClient`, we deliberately do NOT forward `error.message` verbatim
 * — defense-in-depth so a future leak in fetch() can't dribble request data
 * (including the auth header) into our errors.
 */
function liftHttpError<T>(httpErr: {
  code: string;
  message: string;
  status?: number;
}): GithubResult<T> {
  if (httpErr.code === 'TIMEOUT') {
    return { ok: false, error: { code: 'TIMEOUT', message: 'request timed out' } };
  }
  if (httpErr.code === 'ABORTED') {
    return { ok: false, error: { code: 'NETWORK', message: 'request aborted' } };
  }
  if (httpErr.code === 'INVALID_RESPONSE') {
    const out: GithubResult<T> = {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: 'response could not be read' },
    };
    if (typeof httpErr.status === 'number') {
      out.error.status = httpErr.status;
    }
    return out;
  }
  return { ok: false, error: { code: 'NETWORK', message: 'network error' } };
}

function parseScopes(headers: Readonly<Record<string, string>>): string[] {
  // Header lookup is case-insensitive in HTTP, but `headersToRecord` from
  // http-client preserves the casing the server sent. Most servers
  // lowercase, but we check both.
  const raw =
    headers['x-oauth-scopes'] ?? headers['X-OAuth-Scopes'] ?? headers['X-Oauth-Scopes'];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export class GithubClient {
  private readonly httpClient: HttpClient;
  private readonly host: string;
  private readonly authHeader: string;

  constructor(options: GithubClientOptions) {
    this.httpClient = options.httpClient;
    this.host = options.host.replace(/\/+$/, '');
    this.authHeader = `Bearer ${options.auth.token}`;
  }

  /** GET /user — validates the token and returns identity + scopes. */
  async testConnection(): Promise<GithubResult<GithubUser>> {
    const url = `${this.host}/user`;
    const httpReq: HttpRequest = {
      method: 'GET',
      url,
      headers: this.headers(),
    };

    let httpRes: HttpResult;
    try {
      httpRes = await this.httpClient.request(httpReq);
    } catch {
      return { ok: false, error: { code: 'NETWORK', message: 'network error' } };
    }

    if (!httpRes.ok) {
      return liftHttpError<GithubUser>(httpRes.error);
    }

    const { status, headers, body } = httpRes.response;
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: { code: statusToGithubCode(status), message: `GitHub returned ${status}`, status },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body was not valid JSON', status },
      };
    }

    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body did not match expected shape', status },
      };
    }
    const loginRaw = parsed['login'];
    const idRaw = parsed['id'];
    if (typeof loginRaw !== 'string' || typeof idRaw !== 'number' || !Number.isFinite(idRaw)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body did not match expected shape', status },
      };
    }
    const user: GithubUser = {
      login: loginRaw,
      id: idRaw,
      scopes: parseScopes(headers),
    };
    const nameRaw = parsed['name'];
    if (typeof nameRaw === 'string' && nameRaw !== '') {
      user.name = nameRaw;
    }
    return { ok: true, data: user };
  }

  /** GET /user/repos?per_page=100&sort=updated — single page MVP. */
  async listRepos(): Promise<GithubResult<GithubRepoSummary[]>> {
    const url = `${this.host}/user/repos?per_page=100&sort=updated`;
    const httpReq: HttpRequest = {
      method: 'GET',
      url,
      headers: this.headers(),
    };

    let httpRes: HttpResult;
    try {
      httpRes = await this.httpClient.request(httpReq);
    } catch {
      return { ok: false, error: { code: 'NETWORK', message: 'network error' } };
    }

    if (!httpRes.ok) {
      return liftHttpError<GithubRepoSummary[]>(httpRes.error);
    }

    const { status, body } = httpRes.response;
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: { code: statusToGithubCode(status), message: `GitHub returned ${status}`, status },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body was not valid JSON', status },
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body did not match expected shape', status },
      };
    }

    const repos: GithubRepoSummary[] = [];
    for (const item of parsed) {
      if (!isPlainObject(item)) continue;
      const fullName = item['full_name'];
      const defaultBranch = item['default_branch'];
      const isPrivate = item['private'];
      if (
        typeof fullName !== 'string' ||
        typeof defaultBranch !== 'string' ||
        typeof isPrivate !== 'boolean'
      ) {
        continue;
      }
      repos.push({ fullName, defaultBranch, private: isPrivate });
    }
    return { ok: true, data: repos };
  }

  /**
   * GET /repos/{slug}/branches?per_page=100 — list branches on a repo. Same
   * sanitization rules as listRepos: never echo the token in errors.
   */
  async listBranches(slug: string): Promise<GithubResult<GithubBranchSummary[]>> {
    const url = `${this.host}/repos/${slug}/branches?per_page=100`;
    const httpReq: HttpRequest = {
      method: 'GET',
      url,
      headers: this.headers(),
    };

    let httpRes: HttpResult;
    try {
      httpRes = await this.httpClient.request(httpReq);
    } catch {
      return { ok: false, error: { code: 'NETWORK', message: 'network error' } };
    }

    if (!httpRes.ok) {
      return liftHttpError<GithubBranchSummary[]>(httpRes.error);
    }

    const { status, body } = httpRes.response;
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: { code: statusToGithubCode(status), message: `GitHub returned ${status}`, status },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body was not valid JSON', status },
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body did not match expected shape', status },
      };
    }

    const branches: GithubBranchSummary[] = [];
    for (const item of parsed) {
      if (!isPlainObject(item)) continue;
      const nameRaw = item['name'];
      const protectedRaw = item['protected'];
      if (typeof nameRaw !== 'string' || typeof protectedRaw !== 'boolean') {
        continue;
      }
      branches.push({ name: nameRaw, protected: protectedRaw });
    }
    return { ok: true, data: branches };
  }

  /**
   * GET /repos/{slug}/issues — returns the raw GitHub issue array. The
   * source strategy filters out PRs (`pull_request` field present) and
   * maps the survivors to `Ticket` via `ticketFromGithubIssue`. We
   * deliberately keep the array untyped here (`unknown[]`) so the
   * mapping stays in one place upstream.
   */
  async listIssues(
    slug: string,
    opts: { state?: 'open' | 'closed' | 'all'; labels?: string; perPage?: number } = {},
  ): Promise<GithubResult<unknown[]>> {
    const state = opts.state ?? 'open';
    const perPage = opts.perPage ?? 100;
    const labelsParam =
      opts.labels !== undefined && opts.labels !== ''
        ? `&labels=${encodeURIComponent(opts.labels)}`
        : '';
    const url = `${this.host}/repos/${slug}/issues?state=${state}&per_page=${perPage}${labelsParam}`;
    const httpReq: HttpRequest = {
      method: 'GET',
      url,
      headers: this.headers(),
    };

    let httpRes: HttpResult;
    try {
      httpRes = await this.httpClient.request(httpReq);
    } catch {
      return { ok: false, error: { code: 'NETWORK', message: 'network error' } };
    }

    if (!httpRes.ok) {
      return liftHttpError<unknown[]>(httpRes.error);
    }

    const { status, body } = httpRes.response;
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: { code: statusToGithubCode(status), message: `GitHub returned ${status}`, status },
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body was not valid JSON', status },
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body did not match expected shape', status },
      };
    }
    return { ok: true, data: parsed };
  }

  // -- Internals -----------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }
}
