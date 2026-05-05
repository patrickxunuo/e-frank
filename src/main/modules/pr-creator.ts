/**
 * PrCreator — interface + stub implementation for issue #7.
 *
 * The real implementation (issue #11) will call the GitHub / Bitbucket
 * REST API. For #7 we ship the interface and a `StubPrCreator` that
 * returns a deterministic fake URL containing the branch name, so the
 * workflow runner can assert the value flowed through correctly.
 */

export interface CreatePrRequest {
  cwd: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}

export type PrErrorCode = 'AUTH' | 'NETWORK' | 'INVALID_REQUEST' | 'IO_FAILURE';

export type PrResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: PrErrorCode; message: string } };

export interface PrCreator {
  create(req: CreatePrRequest): Promise<PrResult<{ url: string; number: number }>>;
}

/**
 * Stub implementation — returns a deterministic URL whose path contains the
 * branch name (so tests can assert the runner forwarded `branchName` to the
 * PR call). Real implementation lands in #11.
 */
export class StubPrCreator implements PrCreator {
  async create(req: CreatePrRequest): Promise<PrResult<{ url: string; number: number }>> {
    // Don't encode — tests assert the URL contains the literal branchName
    // (e.g. `feature/ABC-1-add-thing`), and this is a stub for testing only.
    const url = `https://example.invalid/pr/${req.branchName}`;
    return { ok: true, data: { url, number: 1 } };
  }
}
