/**
 * `HttpClient` — a tiny abstraction over Node 22's global `fetch` so we can
 * unit-test code that hits Jira without a real network. Mirrors the spawner
 * pattern from #2: a real implementation (`FetchHttpClient`) plus a test
 * double (`FakeHttpClient`) with `expect`/`expectPrefix`/`calls`/`reset`.
 *
 * The error taxonomy is small and stable: NETWORK / TIMEOUT / ABORTED /
 * INVALID_RESPONSE. HTTP error codes (4xx/5xx) are surfaced via `response.status`
 * on `ok: true` responses — the JiraClient layer is responsible for mapping
 * them to its own taxonomy.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** ms; aborted if exceeded. Default 30_000. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** Already-decoded text body. Caller parses JSON. */
  body: string;
}

export type HttpErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INVALID_RESPONSE';

export type HttpResult =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: { code: HttpErrorCode; message: string; status?: number } };

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResult>;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * Real implementation — wraps the global `fetch`. Uses an `AbortController`
 * to enforce `timeoutMs`. We deliberately do NOT include any request body or
 * URL substring detection here; error messages are short and don't echo
 * caller-controlled data so secrets can't leak through this layer.
 */
export class FetchHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const init: RequestInit = {
        method: req.method,
        signal: controller.signal,
      };
      if (req.headers !== undefined) {
        init.headers = req.headers as Record<string, string>;
      }
      if (req.body !== undefined) {
        init.body = req.body;
      }

      let res: Response;
      try {
        res = await fetch(req.url, init);
      } catch (err) {
        if (timedOut) {
          return {
            ok: false,
            error: { code: 'TIMEOUT', message: `request exceeded ${timeoutMs}ms` },
          };
        }
        if (isAbortError(err)) {
          return {
            ok: false,
            error: { code: 'ABORTED', message: 'request aborted' },
          };
        }
        return {
          ok: false,
          error: { code: 'NETWORK', message: errMessage(err) },
        };
      }

      let body: string;
      try {
        body = await res.text();
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'INVALID_RESPONSE',
            message: `failed to read response body: ${errMessage(err)}`,
            status: res.status,
          },
        };
      }

      return {
        ok: true,
        response: {
          status: res.status,
          headers: headersToRecord(res.headers),
          body,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -- Test double -------------------------------------------------------------

interface ExactExpectation {
  kind: 'exact';
  method: HttpRequest['method'];
  url: string;
  response: HttpResult;
}

interface PrefixExpectation {
  kind: 'prefix';
  method: HttpRequest['method'];
  prefix: string;
  response: HttpResult;
}

type Expectation = ExactExpectation | PrefixExpectation;

/**
 * Test double — never makes a real HTTP call. Tests register canned responses
 * via `expect`/`expectPrefix`. Unmatched requests return a NETWORK error
 * whose message names the offending method+url so test failures point at
 * the missing stub directly.
 *
 * Match order: every exact expectation in registration order, then every
 * prefix expectation in registration order. The first match wins.
 */
export class FakeHttpClient implements HttpClient {
  private expectations: Expectation[] = [];
  private readonly _calls: HttpRequest[] = [];

  /** Register a canned response for an exact method+url match. */
  expect(method: HttpRequest['method'], url: string, response: HttpResult): void {
    this.expectations.push({ kind: 'exact', method, url, response });
  }

  /** Register a canned response that matches when the URL starts with `prefix`. */
  expectPrefix(method: HttpRequest['method'], prefix: string, response: HttpResult): void {
    this.expectations.push({ kind: 'prefix', method, prefix, response });
  }

  /** Every call recorded in invocation order. */
  get calls(): ReadonlyArray<HttpRequest> {
    return this._calls;
  }

  /** Reset all expectations and call log. */
  reset(): void {
    this.expectations = [];
    this._calls.length = 0;
  }

  async request(req: HttpRequest): Promise<HttpResult> {
    // Snapshot the request so later mutations to caller-owned objects can't
    // retroactively change what tests observe.
    const snapshot: HttpRequest = {
      method: req.method,
      url: req.url,
    };
    if (req.headers !== undefined) {
      snapshot.headers = { ...req.headers };
    }
    if (req.body !== undefined) {
      snapshot.body = req.body;
    }
    if (req.timeoutMs !== undefined) {
      snapshot.timeoutMs = req.timeoutMs;
    }
    this._calls.push(snapshot);

    // Exact matches first.
    for (const exp of this.expectations) {
      if (exp.kind === 'exact' && exp.method === req.method && exp.url === req.url) {
        return exp.response;
      }
    }
    // Then prefix matches.
    for (const exp of this.expectations) {
      if (exp.kind === 'prefix' && exp.method === req.method && req.url.startsWith(exp.prefix)) {
        return exp.response;
      }
    }
    return {
      ok: false,
      error: {
        code: 'NETWORK',
        message: `FakeHttpClient: no expectation matched ${req.method} ${req.url}`,
      },
    };
  }
}
