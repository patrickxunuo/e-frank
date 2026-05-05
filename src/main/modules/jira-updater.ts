/**
 * JiraUpdater — interface + stub implementation for issue #7.
 *
 * The real implementation (issue #13) will post a comment + transition the
 * Jira ticket via REST API. For #7 we ship the interface and a
 * `StubJiraUpdater` that always succeeds.
 */

export interface UpdateTicketRequest {
  ticketKey: string;
  prUrl: string;
  /** Optional Jira transition (e.g. "In Review"). Stub ignores. */
  transitionTo?: string;
}

export type JiraUpdateErrorCode = 'AUTH' | 'NETWORK' | 'NOT_FOUND' | 'IO_FAILURE';

export type JiraUpdateResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: JiraUpdateErrorCode; message: string } };

export interface JiraUpdater {
  update(req: UpdateTicketRequest): Promise<JiraUpdateResult<{ ticketKey: string }>>;
}

/**
 * Stub implementation — always succeeds. Real impl in #13.
 */
export class StubJiraUpdater implements JiraUpdater {
  async update(req: UpdateTicketRequest): Promise<JiraUpdateResult<{ ticketKey: string }>> {
    return { ok: true, data: { ticketKey: req.ticketKey } };
  }
}
