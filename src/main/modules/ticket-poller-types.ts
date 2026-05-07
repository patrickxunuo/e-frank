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
 * Pagination + sort + search options passed to `TicketSourceClient.listPage`.
 *
 * `cursor` is opaque to callers — Jira packs `startAt`, GitHub packs `page`.
 * Renderer round-trips whatever `nextCursor` came back on the previous call.
 *
 * `sortBy: 'priority'` is honored only by the Jira source. The GitHub source
 * silently degrades to id-order (with the requested direction) when the
 * caller asks for priority — the IPC handler is responsible for not
 * surfacing the priority option to GitHub-backed projects in the first
 * place, but the source is defensive.
 */
export interface TicketListOptions {
  cursor: string | undefined;
  limit: number;
  sortBy: 'id' | 'priority' | undefined;
  sortDir: 'asc' | 'desc' | undefined;
  search: string | undefined;
}

export interface TicketListPage {
  rows: Ticket[];
  nextCursor: string | undefined;
}

/**
 * The strategy contract.
 *
 * - `fetchTickets()` is the legacy single-shot fetch the poller still uses
 *   for its background diff/cache pathway.
 * - `listPage()` is the new paginated/sorted/searched read used by the
 *   `tickets:list` IPC channel.
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
  listPage(opts: TicketListOptions): Promise<
    | { ok: true; data: TicketListPage }
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
