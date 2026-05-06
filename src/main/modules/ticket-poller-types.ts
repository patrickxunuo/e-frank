/**
 * Shared types for the TicketPoller + its source-strategy implementations.
 * Lives in its own file (rather than `ticket-poller.ts`) so the strategies
 * can import them without forming a cycle through the poller class itself.
 */

import type { Ticket } from '../../shared/schema/ticket.js';
import type { Connection } from '../../shared/schema/connection.js';

export type PollerErrorCode =
  | 'AUTH'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NO_TOKEN'
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_RESPONSE';

/**
 * The strategy contract: given a fully-configured client (built by a
 * source-specific factory like `buildJiraSource` / `buildGithubIssuesSource`),
 * `fetchTickets()` runs the actual HTTP call and returns mapped Tickets.
 */
export interface TicketSourceClient {
  fetchTickets(): Promise<
    | { ok: true; tickets: Ticket[] }
    | {
        ok: false;
        code: PollerErrorCode;
        message: string;
        httpStatus?: number;
      }
  >;
}

export interface ConnectionStoreLike {
  get(
    id: string,
  ): Promise<{ ok: true; data: Connection } | { ok: false; error: unknown }>;
}

export interface SecretsManagerLike {
  get(
    ref: string,
  ): Promise<{ ok: true; data: { plaintext: string } } | { ok: false; error: unknown }>;
}
