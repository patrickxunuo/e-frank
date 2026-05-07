/**
 * `github-issues-source` — TicketSourceClient strategy for GitHub Issues.
 *
 * Resolves the project's `tickets.connectionId` via the ConnectionStore +
 * SecretsManager, builds a GithubClient, and returns a `TicketSourceClient`
 * whose `fetchTickets()` calls `listIssues(repoSlug, { labels })`. The raw
 * issue array is filtered (PRs out — `pull_request !== undefined`) and
 * mapped through `ticketFromGithubIssue` here so the poller stays unaware
 * of the wire shape.
 *
 * Error mapping mirrors the Jira strategy:
 *   - missing connectionId / failed lookup / failed/empty secret → NO_TOKEN
 *   - GithubClient.listIssues errors → poller-level codes (NOT_FOUND collapses
 *     to INVALID_RESPONSE, mirroring the Jira mapping for renderer parity).
 */

import { GithubClient, type GithubErrorCode } from './github-client.js';
import type { HttpClient } from './http-client.js';
import {
  ticketFromGithubIssue,
  type Ticket,
} from '../../shared/schema/ticket.js';
import type {
  ProjectInstance,
  TicketsGithubIssuesConfig,
} from '../../shared/schema/project-instance.js';
import type {
  ConnectionStoreLike,
  PollerErrorCode,
  SecretsManagerLike,
  TicketSourceClient,
} from './ticket-poller-types.js';

export interface GithubIssuesSourceDeps {
  connectionStore: ConnectionStoreLike;
  secretsManager: SecretsManagerLike;
  httpClient: HttpClient;
  /** Test seam. */
  githubClientFactory?: (opts: {
    httpClient: HttpClient;
    host: string;
    auth: { token: string };
  }) => GithubClient;
}

function githubCodeToPollerCode(code: GithubErrorCode): PollerErrorCode {
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function buildGithubIssuesSource(
  project: ProjectInstance,
  deps: GithubIssuesSourceDeps,
): Promise<
  | { ok: true; client: TicketSourceClient }
  | { ok: false; code: PollerErrorCode; message: string }
> {
  if (project.tickets.source !== 'github-issues') {
    return {
      ok: false,
      code: 'INVALID_RESPONSE',
      message: `expected github-issues source, got "${project.tickets.source}"`,
    };
  }
  const tickets: TicketsGithubIssuesConfig = project.tickets;
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

  const factory =
    deps.githubClientFactory ?? ((opts) => new GithubClient(opts));
  const client = factory({
    httpClient: deps.httpClient,
    host: connection.host,
    auth: { token: plaintext },
  });

  const repoSlug = tickets.repoSlug;
  const labels = tickets.labels;

  const sourceClient: TicketSourceClient = {
    // Non-async wrapper: same rationale as jira-source — keep the await
    // depth shallow so the existing POLLER-005 mutex test's microtask
    // assumptions don't drift.
    fetchTickets(): ReturnType<TicketSourceClient['fetchTickets']> {
      const opts: { labels?: string } = {};
      if (labels !== undefined && labels !== '') {
        opts.labels = labels;
      }
      return client.listIssues(repoSlug, opts).then((res) => {
        if (!res.ok) {
          const code = githubCodeToPollerCode(res.error.code);
          const out: {
            ok: false;
            code: PollerErrorCode;
            message: string;
            httpStatus?: number;
          } = {
            ok: false,
            code,
            message: `GitHub issues fetch failed: ${code}`,
          };
          if (typeof res.error.status === 'number') {
            out.httpStatus = res.error.status;
          }
          return out;
        }
        // Map raw GitHub issue objects → Ticket. The mapper filters out PRs
        // (presence of `pull_request`) and any object that doesn't look like
        // an issue. We belt-and-suspender that filter here too — defensive
        // against a future mapper change.
        const tickets: Ticket[] = [];
        for (const raw of res.data) {
          if (isPlainObject(raw) && raw['pull_request'] !== undefined) continue;
          const t = ticketFromGithubIssue(raw, repoSlug);
          if (t !== null) tickets.push(t);
        }
        return { ok: true, tickets };
      });
    },
  };
  return { ok: true, client: sourceClient };
}
