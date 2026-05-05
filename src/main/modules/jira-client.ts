/**
 * `JiraClient` — typed wrapper around Jira Cloud's REST v3 API. Two endpoints
 * for now: `/rest/api/3/search` (JQL → Tickets) and `/rest/api/3/myself`
 * (credential check). All HTTP goes through an injected `HttpClient` so this
 * module is unit-testable with `FakeHttpClient`.
 *
 * Security invariant: the `apiToken` MUST NEVER appear in any error message,
 * thrown error, or log line. Every error path in this file is sanitized —
 * we propagate codes and short, fixed messages, never the underlying
 * `error.message` from the network layer when it could echo a header.
 */

import type { HttpClient, HttpRequest, HttpResult } from './http-client.js';
import { ticketFromJiraIssue, type Ticket } from '../../shared/schema/ticket.js';

export interface JiraAuth {
  /** User email (Jira Cloud uses email + API token; Server users put their username here). */
  email: string;
  /** API token / PAT. NEVER logged. */
  apiToken: string;
}

export interface JiraClientOptions {
  httpClient: HttpClient;
  /** Base URL like "https://example.atlassian.net" — no trailing slash. */
  host: string;
  auth: JiraAuth;
}

export type JiraErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE';

export type JiraResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: JiraErrorCode; message: string; status?: number } };

export interface JiraSearchOptions {
  /** Defaults to 50. Jira max is 100. */
  maxResults?: number;
  /** Fields to fetch. Defaults to ['summary','status','priority','assignee','updated']. */
  fields?: ReadonlyArray<string>;
}

export interface JiraSearchResponse {
  total: number;
  tickets: Ticket[];
}

export interface JiraSelfResponse {
  /** "accountId" on Cloud, "name" on Server. */
  accountId: string;
  displayName: string;
  emailAddress: string;
}

const DEFAULT_FIELDS: ReadonlyArray<string> = [
  'summary',
  'status',
  'priority',
  'assignee',
  'updated',
];
const DEFAULT_MAX_RESULTS = 50;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Build the `Authorization: Basic <base64>` header value for Jira Cloud.
 * Done via `Buffer.from(...).toString('base64')` (Node 22 has Buffer in main).
 */
function buildBasicAuth(auth: JiraAuth): string {
  const raw = `${auth.email}:${auth.apiToken}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Translate an HTTP `status` to a `JiraErrorCode`. Per the spec:
 * - 401, 403 → AUTH
 * - 404 → NOT_FOUND
 * - 429 → RATE_LIMITED
 * - 5xx → SERVER_ERROR
 * - other 4xx → AUTH (already handled) else INVALID_RESPONSE
 */
function statusToJiraCode(status: number): JiraErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status < 600) return 'SERVER_ERROR';
  // Other 4xx — surface as INVALID_RESPONSE (we have no better mapping).
  return 'INVALID_RESPONSE';
}

/**
 * Lift an `HttpResult` low-level error into a sanitized JiraResult error.
 * We deliberately do NOT forward `error.message` verbatim — at the network
 * layer these messages should already be safe, but defense-in-depth: cap
 * the messages to short, fixed strings here so a future leak in fetch() or
 * a misbehaving environment can't dribble request data into our errors.
 */
function liftHttpError<T>(httpErr: { code: string; message: string; status?: number }): JiraResult<T> {
  if (httpErr.code === 'TIMEOUT') {
    return { ok: false, error: { code: 'TIMEOUT', message: 'request timed out' } };
  }
  if (httpErr.code === 'ABORTED') {
    return { ok: false, error: { code: 'NETWORK', message: 'request aborted' } };
  }
  if (httpErr.code === 'INVALID_RESPONSE') {
    const out: JiraResult<T> = {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: 'response could not be read' },
    };
    if (typeof httpErr.status === 'number') {
      out.error.status = httpErr.status;
    }
    return out;
  }
  // NETWORK and anything unexpected → NETWORK.
  return { ok: false, error: { code: 'NETWORK', message: 'network error' } };
}

export class JiraClient {
  private readonly httpClient: HttpClient;
  private readonly host: string;
  private readonly authHeader: string;

  constructor(options: JiraClientOptions) {
    this.httpClient = options.httpClient;
    // Defensively trim a trailing slash so callers can't double-slash URLs.
    this.host = options.host.replace(/\/+$/, '');
    this.authHeader = buildBasicAuth(options.auth);
  }

  /**
   * GET /rest/api/3/search — runs JQL and returns mapped Tickets.
   *
   * URL template:
   *   ${host}/rest/api/3/search?jql=${encodeURIComponent(jql)}
   *     &maxResults=${maxResults}&fields=${fields.join(',')}
   */
  async search(jql: string, opts: JiraSearchOptions = {}): Promise<JiraResult<JiraSearchResponse>> {
    const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;
    const fields = opts.fields ?? DEFAULT_FIELDS;

    const url =
      `${this.host}/rest/api/3/search` +
      `?jql=${encodeURIComponent(jql)}` +
      `&maxResults=${maxResults}` +
      `&fields=${encodeURIComponent(fields.join(','))}`;

    return this.requestJson<JiraSearchResponse>('GET', url, (parsed) => {
      if (!isPlainObject(parsed)) {
        return null;
      }
      const totalRaw = parsed['total'];
      const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : 0;
      const issues = parsed['issues'];
      if (!Array.isArray(issues)) {
        return null;
      }
      const tickets: Ticket[] = [];
      for (const issue of issues) {
        const t = ticketFromJiraIssue(issue, this.host);
        if (t !== null) {
          tickets.push(t);
        }
      }
      return { total, tickets };
    });
  }

  /** GET /rest/api/3/myself — verifies credentials. */
  async testConnection(): Promise<JiraResult<JiraSelfResponse>> {
    const url = `${this.host}/rest/api/3/myself`;
    return this.requestJson<JiraSelfResponse>('GET', url, (parsed) => {
      if (!isPlainObject(parsed)) {
        return null;
      }
      // Cloud returns `accountId`; Server returns `name`. Fall back so
      // either flavor produces a usable JiraSelfResponse.
      const accountIdRaw = parsed['accountId'];
      const nameRaw = parsed['name'];
      const accountId =
        typeof accountIdRaw === 'string' && accountIdRaw !== ''
          ? accountIdRaw
          : typeof nameRaw === 'string'
            ? nameRaw
            : '';
      const displayNameRaw = parsed['displayName'];
      const emailRaw = parsed['emailAddress'];
      return {
        accountId,
        displayName: typeof displayNameRaw === 'string' ? displayNameRaw : '',
        emailAddress: typeof emailRaw === 'string' ? emailRaw : '',
      };
    });
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Run a request, parse the body as JSON, and pass the parsed value through
   * `mapper`. The mapper returns `null` to signal a body shape we couldn't
   * interpret (→ INVALID_RESPONSE).
   *
   * NOTE: every error path here is sanitized — we never forward the raw body
   * or low-level message that could plausibly contain auth headers.
   */
  private async requestJson<T>(
    method: HttpRequest['method'],
    url: string,
    mapper: (parsed: unknown) => T | null,
  ): Promise<JiraResult<T>> {
    const httpReq: HttpRequest = {
      method,
      url,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
      },
    };

    let httpRes: HttpResult;
    try {
      httpRes = await this.httpClient.request(httpReq);
    } catch {
      // Any thrown error from the http layer is sanitized here — we don't
      // include the message because it could in theory echo headers.
      return { ok: false, error: { code: 'NETWORK', message: 'network error' } };
    }

    if (!httpRes.ok) {
      return liftHttpError<T>(httpRes.error);
    }

    const { status, body } = httpRes.response;
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        error: { code: statusToJiraCode(status), message: `Jira returned ${status}`, status },
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

    const mapped = mapper(parsed);
    if (mapped === null) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: 'response body did not match expected shape', status },
      };
    }
    return { ok: true, data: mapped };
  }
}
