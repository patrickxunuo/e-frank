import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunLogStore } from '../../src/main/modules/run-log-store';
import type { RunLogStoreFs } from '../../src/main/modules/run-log-store';
import type { RunLogEntry } from '../../src/shared/schema/run';

/**
 * RUNLOG-001..006 — RunLogStore (per-run NDJSON sidecar persistence).
 *
 * Mirrors the in-memory `ProjectStoreFs` stub from `run-store.test.ts` but
 * for an append-only model:
 *   - `appendFile(path, data, 'utf8')` — concatenates `data` to the in-memory
 *     string for `path`. Used for adding a single NDJSON line.
 *   - `readFile(path, 'utf8')` — returns the full file contents (or throws
 *     ENOENT if missing).
 *   - `mkdir(path, { recursive: true })` — recorded as an op for RUNLOG-001.
 *
 * No rename/unlink — the spec calls out append-only NDJSON.
 */

// ---------------------------------------------------------------------------
// In-memory RunLogStoreFs stub
// ---------------------------------------------------------------------------

type FsOp =
  | { kind: 'appendFile'; path: string; data: string }
  | { kind: 'readFile'; path: string }
  | { kind: 'mkdir'; path: string };

interface MemFs extends RunLogStoreFs {
  files: Map<string, string>;
  ops: FsOp[];
  /** Force `readFile` on this path to throw a non-ENOENT error (RUNLOG-006). */
  readFileError?: { path: string; code: string };
}

function createMemFs(initial: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: FsOp[] = [];
  const fs: MemFs = {
    files,
    ops,
    async appendFile(path: string, data: string, _enc: 'utf8'): Promise<void> {
      ops.push({ kind: 'appendFile', path, data });
      const prev = files.get(path) ?? '';
      files.set(path, prev + data);
    },
    async readFile(path: string, _enc: 'utf8'): Promise<string> {
      ops.push({ kind: 'readFile', path });
      if (fs.readFileError && fs.readFileError.path === path) {
        const err = new Error(`forced fs error on ${path}`) as NodeJS.ErrnoException;
        err.code = fs.readFileError.code;
        throw err;
      }
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${path}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    async mkdir(path: string, _opts: { recursive: true }): Promise<void> {
      ops.push({ kind: 'mkdir', path });
    },
  };
  return fs;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUNS_DIR = '/userData/runs';

function makeEntry(over: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    runId: 'run-1',
    stream: 'stdout',
    line: 'hello world',
    timestamp: 1_700_000_000_000,
    state: 'running',
    ...over,
  };
}

function logPathFor(runId: string): string {
  // Per spec: `runsDir/{runId}.log`. RunLogStore is the source of truth — we
  // assert the helper-computed expected path here.
  return `${RUNS_DIR}/${runId}.log`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunLogStore', () => {
  let fs: MemFs;
  let store: RunLogStore;

  beforeEach(() => {
    fs = createMemFs();
    store = new RunLogStore({ runsDir: RUNS_DIR, fs });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-001 — init() creates the runs directory if missing
  // -------------------------------------------------------------------------
  it('RUNLOG-001: init() calls mkdir with { recursive: true } on the runs directory', async () => {
    const res = await store.init();
    expect(res.ok).toBe(true);

    const mkdirOp = fs.ops.find(
      (op): op is Extract<FsOp, { kind: 'mkdir' }> =>
        op.kind === 'mkdir' && op.path === RUNS_DIR,
    );
    expect(mkdirOp).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // RUNLOG-002 — appendLine writes one NDJSON line per entry
  // -------------------------------------------------------------------------
  it('RUNLOG-002: appendLine() invokes fs.appendFile with `${JSON.stringify(entry)}\\n`', async () => {
    await store.init();
    fs.ops.length = 0;

    const entry = makeEntry({
      runId: 'run-42',
      stream: 'stderr',
      line: 'oops',
      timestamp: 1_700_000_000_001,
      state: 'failed',
    });
    const res = await store.appendLine(entry);
    expect(res.ok).toBe(true);

    const appendOp = fs.ops.find(
      (op): op is Extract<FsOp, { kind: 'appendFile' }> =>
        op.kind === 'appendFile' && op.path === logPathFor('run-42'),
    );
    expect(appendOp).toBeDefined();
    expect(appendOp!.data).toBe(`${JSON.stringify(entry)}\n`);
  });

  // -------------------------------------------------------------------------
  // RUNLOG-003 — read() of a missing log returns ok with empty entries
  // -------------------------------------------------------------------------
  it('RUNLOG-003: read() of a missing log → ok, entries: []', async () => {
    await store.init();
    const res = await store.read('does-not-exist');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // RUNLOG-004 — read() of an existing log returns parsed entries
  // -------------------------------------------------------------------------
  it('RUNLOG-004: read() returns 3 parsed entries from a 3-line NDJSON file', async () => {
    await store.init();
    const e1 = makeEntry({ runId: 'r-3', line: 'one', state: 'running' });
    const e2 = makeEntry({ runId: 'r-3', line: 'two', state: 'running' });
    const e3 = makeEntry({
      runId: 'r-3',
      line: 'three',
      stream: 'stderr',
      state: 'committing',
    });
    fs.files.set(
      logPathFor('r-3'),
      `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n${JSON.stringify(e3)}\n`,
    );

    const res = await store.read('r-3');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(3);
    expect(res.data[0]).toEqual(e1);
    expect(res.data[1]).toEqual(e2);
    expect(res.data[2]).toEqual(e3);
  });

  // -------------------------------------------------------------------------
  // RUNLOG-005 — read() skips malformed NDJSON lines (logged warn)
  // -------------------------------------------------------------------------
  it('RUNLOG-005: read() skips malformed lines and logs a warning', async () => {
    await store.init();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ok1 = makeEntry({ runId: 'r-malformed', line: 'good-1' });
    const ok2 = makeEntry({ runId: 'r-malformed', line: 'good-2' });
    fs.files.set(
      logPathFor('r-malformed'),
      `${JSON.stringify(ok1)}\n{this is not json\n${JSON.stringify(ok2)}\n`,
    );

    const res = await store.read('r-malformed');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(2);
    expect(res.data[0]?.line).toBe('good-1');
    expect(res.data[1]?.line).toBe('good-2');
    // The malformed line triggers a warn somewhere.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // -------------------------------------------------------------------------
  // RUNLOG-006 — read() with non-ENOENT fs error returns IO_FAILURE
  // -------------------------------------------------------------------------
  it('RUNLOG-006: read() of a path that throws non-ENOENT → ok=false, code=IO_FAILURE', async () => {
    await store.init();
    fs.readFileError = { path: logPathFor('boom'), code: 'EACCES' };

    const res = await store.read('boom');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('IO_FAILURE');
  });
});
