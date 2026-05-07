/**
 * `jira-source` — TicketSourceClient strategy for Jira.
 *
 * Resolves the project's `tickets.connectionId` via the ConnectionStore +
 * SecretsManager, splits the stored "email\ntoken" plaintext, and returns
 * a `TicketSourceClient` whose `fetchTickets()` runs the project's JQL via
 * the JiraClient. Auth resolution happens once when the strategy is built;
 * the resulting client is reused for the lifetime of one poll. Connection
 * lookups happen on every poll cycle (the poller calls the factory each
 * tick) so token rotations / connection edits land without restart.
 *
 * Error mapping:
 *   - `connectionId` missing/empty → NO_TOKEN
 *   - connection lookup fails → NO_TOKEN
 *   - secret lookup fails / empty → NO_TOKEN
 *   - JiraClient.search returns a JiraErrorCode → mapped through
 *     `jiraCodeToPollerCode` (NOT_FOUND collapses to INVALID_RESPONSE)
 *
 * Security: the plaintext token NEVER appears in any returned message.
 */

import { JiraClient, type JiraErrorCode } from './jira-client.js';
import type { HttpClient } from './http-client.js';
import type {
  ProjectInstance,
  TicketsJiraConfig,
} from '../../shared/schema/project-instance.js';
import type {
  ConnectionStoreLike,
  PollerErrorCode,
  SecretsManagerLike,
  TicketListOptions,
  TicketListPage,
  TicketSourceClient,
} from './ticket-poller-types.js';

export interface JiraSourceDeps {
  connectionStore: ConnectionStoreLike;
  secretsManager: SecretsManagerLike;
  httpClient: HttpClient;
  /** Test seam — defaults to `(opts) => new JiraClient(opts)`. */
  jiraClientFactory?: (opts: {
    httpClient: HttpClient;
    host: string;
    auth: { email: string; apiToken: string };
  }) => JiraClient;
}

/**
 * Map a `JiraErrorCode` to the poller's narrower `PollerErrorCode`. They
 * overlap mostly 1:1; the poller adds NO_TOKEN / PROJECT_NOT_FOUND, and we
 * never expose `NOT_FOUND` from Jira (which would mean "wrong endpoint" —
 * surface it as INVALID_RESPONSE).
 */
function jiraCodeToPollerCode(code: JiraErrorCode): PollerErrorCode {
  switch (code) {
    case 'AUTH':
      return 'AUTH';
    case 'NETWORK':
      return 'NETWORK';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'SERVER_ERROR':
      return 'SERVER_ERROR';
    case 'INVALID_RESPONSE':
      return 'INVALID_RESPONSE';
    case 'NOT_FOUND':
      return 'INVALID_RESPONSE';
  }
}

export async function buildJiraSource(
  project: ProjectInstance,
  deps: JiraSourceDeps,
): Promise<
  | { ok: true; client: TicketSourceClient }
  | { ok: false; code: PollerErrorCode; message: string }
> {
  // Strategy-builder lives behind the poller's source factory, so the
  // discriminator narrowing is structural — caller already knows source ===
  // 'jira', but we re-narrow defensively here.
  if (project.tickets.source !== 'jira') {
    return {
      ok: false,
      code: 'INVALID_RESPONSE',
      message: `expected jira source, got "${project.tickets.source}"`,
    };
  }
  const tickets: TicketsJiraConfig = project.tickets;
  const connectionId = tickets.connectionId;
  if (connectionId === undefined || connectionId === '') {
    return {
      ok: false,
      code: 'NO_TOKEN',
      message: 'project has no tickets.connectionId configured',
    };
  }
  const connectionRes = await deps.connectionStore.get(connectionId);
  if (!connectionRes.ok) {
    return {
      ok: false,
      code: 'NO_TOKEN',
      message: `connection "${connectionId}" could not be resolved`,
    };
  }
  const connection = connectionRes.data;
  const tokenRes = await deps.secretsManager.get(connection.secretRef);
  if (!tokenRes.ok) {
    return {
      ok: false,
      code: 'NO_TOKEN',
      message: `secret "${connection.secretRef}" could not be resolved`,
    };
  }
  const plaintext = tokenRes.data.plaintext;
  if (plaintext === '') {
    return {
      ok: false,
      code: 'NO_TOKEN',
      message: `secret "${connection.secretRef}" is empty`,
    };
  }
  // Jira `api-token` connections store the secret as `email\ntoken`.
  // Defense-in-depth fallback: if no newline is present, treat the whole
  // value as the token and email as ''. testConnection / search will
  // surface AUTH on the next round-trip in that pathological case.
  let email: string;
  let apiToken: string;
  const nl = plaintext.indexOf('\n');
  if (nl < 0) {
    email = '';
    apiToken = plaintext;
  } else {
    email = plaintext.slice(0, nl);
    apiToken = plaintext.slice(nl + 1);
  }

  const factory =
    deps.jiraClientFactory ?? ((opts) => new JiraClient(opts));
  const client = factory({
    httpClient: deps.httpClient,
    host: connection.host,
    auth: { email, apiToken },
  });

  const baseJql = tickets.query ?? `project = "${tickets.projectKey}"`;

  /**
   * Compose a JQL string by augmenting the project's base query with an
   * optional `text ~ "..."` clause for free-text search and an optional
   * `ORDER BY` for sorted reads. JQL syntax:
   *   - String literals are double-quoted; inner `"` and `\` need escaping.
   *   - `text ~` does word-token matching; no wildcards needed for prefix.
   *   - Multiple ORDER BY clauses are comma-separated; first wins, rest
   *     break ties.
   *
   * The base JQL may itself contain an `ORDER BY` (project owners sometimes
   * embed one in `tickets.query`). In that case the user's clause wins —
   * we only append an ORDER BY when the base doesn't already have one.
   */
  function composeJql(opts: TicketListOptions): string {
    const trimmedSearch = (opts.search ?? '').trim();
    let jql = baseJql;

    // Attach a `text ~` clause when search is non-empty. Wrap the user's
    // input in quotes after escaping backslashes and inner quotes — JQL
    // string literal rules.
    if (trimmedSearch !== '') {
      const escaped = trimmedSearch.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // If the base JQL already has an ORDER BY, splice the AND in before
      // it so the ORDER stays at the tail. Otherwise just append.
      const orderByIdx = jql.search(/\bORDER\s+BY\b/i);
      if (orderByIdx >= 0) {
        const head = jql.slice(0, orderByIdx).trimEnd();
        const tail = jql.slice(orderByIdx);
        jql = `${head} AND text ~ "${escaped}" ${tail}`;
      } else {
        jql = `${jql} AND text ~ "${escaped}"`;
      }
    }

    // Append ORDER BY only if the base JQL didn't already include one.
    if (opts.sortBy !== undefined && !/\bORDER\s+BY\b/i.test(jql)) {
      const dir = opts.sortDir === 'asc' ? 'ASC' : 'DESC';
      const field = opts.sortBy === 'priority' ? 'priority' : 'key';
      // Tiebreak by key so equal-priority tickets stay in a stable order.
      jql =
        opts.sortBy === 'priority'
          ? `${jql} ORDER BY ${field} ${dir}, key ${dir}`
          : `${jql} ORDER BY ${field} ${dir}`;
    }

    return jql;
  }

  const sourceClient: TicketSourceClient = {
    // Non-async wrapper: returns `client.search()` directly (then `.then` for
    // mapping) so we don't add an extra microtask wrap around the existing
    // JiraClient.search await chain. Keeps the original POLLER-005 timing
    // assertions intact.
    fetchTickets(): ReturnType<TicketSourceClient['fetchTickets']> {
      return client.search(baseJql).then((res) => {
        if (!res.ok) {
          const code = jiraCodeToPollerCode(res.error.code);
          const out: {
            ok: false;
            code: PollerErrorCode;
            message: string;
            httpStatus?: number;
          } = {
            ok: false,
            code,
            message: `Jira search failed: ${code}`,
          };
          if (typeof res.error.status === 'number') {
            out.httpStatus = res.error.status;
          }
          return out;
        }
        return { ok: true, tickets: [...res.data.tickets] };
      });
    },

    listPage(opts): ReturnType<TicketSourceClient['listPage']> {
      const startAt = opts.cursor !== undefined ? Number.parseInt(opts.cursor, 10) : 0;
      // Cursor is a string for opacity but we stamped it as a digit string
      // in `nextCursor`. NaN means a malformed/forged cursor — treat as 0.
      const safeStartAt = Number.isFinite(startAt) && startAt >= 0 ? startAt : 0;
      const jql = composeJql(opts);
      return client
        .search(jql, { startAt: safeStartAt, maxResults: opts.limit })
        .then((res) => {
          if (!res.ok) {
            const code = jiraCodeToPollerCode(res.error.code);
            const out: {
              ok: false;
              code: PollerErrorCode;
              message: string;
              httpStatus?: number;
            } = {
              ok: false,
              code,
              message: `Jira search failed: ${code}`,
            };
            if (typeof res.error.status === 'number') {
              out.httpStatus = res.error.status;
            }
            return out;
          }
          const consumed = res.data.startAt + res.data.tickets.length;
          const data: TicketListPage = {
            rows: [...res.data.tickets],
            nextCursor: consumed < res.data.total ? String(consumed) : undefined,
          };
          return { ok: true, data };
        });
    },
  };
  return { ok: true, client: sourceClient };
}
