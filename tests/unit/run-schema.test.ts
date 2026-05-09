import { describe, it, expect, expectTypeOf } from 'vitest';
import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ApprovalRequest,
  ApprovalResponse,
  Run,
  RunMode,
  RunState,
  RunStateEvent,
  RunStatus,
  RunStep,
} from '../../src/shared/schema/run';

/**
 * RUN-SCHEMA-001..002 — type-only assertions over the Run schema.
 *
 * These tests serve two purposes:
 *  1. Compile-time: lock the union members of `RunState` / `RunMode` /
 *     `RunStatus`, the shape of `Run`, `RunStep`, `RunStateEvent`,
 *     `ApprovalRequest`, `ApprovalResponse`. If Agent B drifts the schema,
 *     these `expectTypeOf` assertions stop type-checking.
 *  2. Renderer-safety: the schema lives at `src/shared/schema/run.ts` and is
 *     pulled into `shared/ipc.ts` (which the renderer imports). It MUST NOT
 *     reference Node-only modules (`node:fs`, `electron`, etc.) — the file is
 *     read as text and scanned for forbidden substrings.
 *
 * Note on the "renderer-safe" check: we read the SOURCE of the schema file
 * directly (resolved relative to this test) rather than relying on the
 * runtime import — interface declarations vanish after compilation, so a
 * type-only `import` from `node:foo` in the schema would not show up at
 * runtime. Reading the text guards against that.
 */

const RUN_STATE_VALUES: ReadonlyArray<RunState> = [
  'idle',
  'locking',
  'preparing',
  'fetchingTicket',
  'branching',
  'understandingContext',
  'planning',
  'running',
  'awaitingApproval',
  'implementing',
  'evaluatingTests',
  'reviewingCode',
  'committing',
  'pushing',
  'creatingPr',
  'updatingTicket',
  'unlocking',
  'done',
  'failed',
  'cancelled',
];

describe('src/shared/schema/run.ts — Run schema', () => {
  // -------------------------------------------------------------------------
  // RUN-SCHEMA-001 — union covers the 20 documented RunState values
  // (14 originals + 6 added by GH-52: fetchingTicket, understandingContext,
  // planning, implementing, evaluatingTests, reviewingCode)
  // -------------------------------------------------------------------------
  describe('RUN-SCHEMA-001 RunState union', () => {
    it('RUN-SCHEMA-001: every documented state is assignable to RunState', () => {
      // If any literal here is NOT in the union, the assignment below stops
      // type-checking. The runtime check ensures we have all 20 entries.
      expect(RUN_STATE_VALUES).toHaveLength(20);
      for (const v of RUN_STATE_VALUES) {
        // Re-assign each value to the typed alias to force a structural check.
        const checked: RunState = v;
        expect(typeof checked).toBe('string');
      }
    });

    it('RUN-SCHEMA-001: RunState is the discriminated union of the 20 literals', () => {
      // Compile-time: RunState ≡ union of the 20 string literals.
      type Expected =
        | 'idle'
        | 'locking'
        | 'preparing'
        | 'fetchingTicket'
        | 'branching'
        | 'understandingContext'
        | 'planning'
        | 'running'
        | 'awaitingApproval'
        | 'implementing'
        | 'evaluatingTests'
        | 'reviewingCode'
        | 'committing'
        | 'pushing'
        | 'creatingPr'
        | 'updatingTicket'
        | 'unlocking'
        | 'done'
        | 'failed'
        | 'cancelled';
      expectTypeOf<RunState>().toEqualTypeOf<Expected>();
    });

    it('RUN-SCHEMA-001: RunMode covers interactive | yolo', () => {
      expectTypeOf<RunMode>().toEqualTypeOf<'interactive' | 'yolo'>();
    });

    it('RUN-SCHEMA-001: RunStatus covers pending | running | done | failed | cancelled', () => {
      expectTypeOf<RunStatus>().toEqualTypeOf<
        'pending' | 'running' | 'done' | 'failed' | 'cancelled'
      >();
    });
  });

  // -------------------------------------------------------------------------
  // RUN-SCHEMA-002 — interfaces compile + renderer-safe
  // -------------------------------------------------------------------------
  describe('RUN-SCHEMA-002 interfaces compile and module is renderer-safe', () => {
    it('RUN-SCHEMA-002: RunStep has the expected fields', () => {
      expectTypeOf<RunStep>().toHaveProperty('state');
      expectTypeOf<RunStep['state']>().toEqualTypeOf<RunState>();
      expectTypeOf<RunStep>().toHaveProperty('userVisibleLabel');
      expectTypeOf<RunStep['userVisibleLabel']>().toEqualTypeOf<string | null>();
      expectTypeOf<RunStep>().toHaveProperty('status');
      expectTypeOf<RunStep['status']>().toEqualTypeOf<RunStatus>();
      // `startedAt` / `finishedAt` / `error` are optional.
      expectTypeOf<RunStep['startedAt']>().toEqualTypeOf<number | undefined>();
      expectTypeOf<RunStep['finishedAt']>().toEqualTypeOf<number | undefined>();
      expectTypeOf<RunStep['error']>().toEqualTypeOf<string | undefined>();
    });

    it('RUN-SCHEMA-002: ApprovalRequest has the expected fields', () => {
      expectTypeOf<ApprovalRequest>().toHaveProperty('raw');
      expectTypeOf<ApprovalRequest['raw']>().toEqualTypeOf<unknown>();
      expectTypeOf<ApprovalRequest['plan']>().toEqualTypeOf<string | undefined>();
      expectTypeOf<ApprovalRequest['filesToModify']>().toEqualTypeOf<
        string[] | undefined
      >();
      expectTypeOf<ApprovalRequest['diff']>().toEqualTypeOf<string | undefined>();
      expectTypeOf<ApprovalRequest['options']>().toEqualTypeOf<
        string[] | undefined
      >();
    });

    it('RUN-SCHEMA-002: Run has the expected fields with correct types', () => {
      expectTypeOf<Run>().toHaveProperty('id');
      expectTypeOf<Run['id']>().toEqualTypeOf<string>();
      expectTypeOf<Run>().toHaveProperty('projectId');
      expectTypeOf<Run['projectId']>().toEqualTypeOf<string>();
      expectTypeOf<Run>().toHaveProperty('ticketKey');
      expectTypeOf<Run['ticketKey']>().toEqualTypeOf<string>();
      expectTypeOf<Run>().toHaveProperty('mode');
      expectTypeOf<Run['mode']>().toEqualTypeOf<RunMode>();
      expectTypeOf<Run>().toHaveProperty('branchName');
      expectTypeOf<Run['branchName']>().toEqualTypeOf<string>();
      expectTypeOf<Run>().toHaveProperty('state');
      expectTypeOf<Run['state']>().toEqualTypeOf<RunState>();
      expectTypeOf<Run>().toHaveProperty('status');
      expectTypeOf<Run['status']>().toEqualTypeOf<RunStatus>();
      expectTypeOf<Run>().toHaveProperty('steps');
      expectTypeOf<Run['steps']>().toEqualTypeOf<RunStep[]>();
      expectTypeOf<Run>().toHaveProperty('pendingApproval');
      expectTypeOf<Run['pendingApproval']>().toEqualTypeOf<
        ApprovalRequest | null
      >();
      expectTypeOf<Run>().toHaveProperty('startedAt');
      expectTypeOf<Run['startedAt']>().toEqualTypeOf<number>();
      // Optional result fields.
      expectTypeOf<Run['prUrl']>().toEqualTypeOf<string | undefined>();
      expectTypeOf<Run['finishedAt']>().toEqualTypeOf<number | undefined>();
      expectTypeOf<Run['error']>().toEqualTypeOf<string | undefined>();
    });

    it('RUN-SCHEMA-002: RunStateEvent has runId + run snapshot', () => {
      expectTypeOf<RunStateEvent>().toHaveProperty('runId');
      expectTypeOf<RunStateEvent['runId']>().toEqualTypeOf<string>();
      expectTypeOf<RunStateEvent>().toHaveProperty('run');
      expectTypeOf<RunStateEvent['run']>().toEqualTypeOf<Run>();
    });

    it('RUN-SCHEMA-002: ApprovalResponse covers approve | reject | modify with text on modify', () => {
      expectTypeOf<ApprovalResponse>().toHaveProperty('runId');
      expectTypeOf<ApprovalResponse['runId']>().toEqualTypeOf<string>();
      expectTypeOf<ApprovalResponse>().toHaveProperty('decision');
      expectTypeOf<ApprovalResponse['decision']>().toEqualTypeOf<
        'approve' | 'reject' | 'modify'
      >();
      // `text` is required only when decision === 'modify'; the schema models
      // it as optional `string`.
      expectTypeOf<ApprovalResponse['text']>().toEqualTypeOf<string | undefined>();
    });

    it('RUN-SCHEMA-002: Run / RunStep can be constructed (compile-only structural check)', () => {
      // This block compiles iff every field has the documented type — no
      // runtime assertions needed beyond constructing a value successfully.
      const step: RunStep = {
        state: 'running',
        userVisibleLabel: 'Implementing feature',
        status: 'running',
        startedAt: 1,
      };
      const run: Run = {
        id: 'r-1',
        projectId: 'p-1',
        ticketKey: 'ABC-1',
        mode: 'interactive',
        branchName: 'feat/abc-1',
        state: 'running',
        status: 'running',
        steps: [step],
        pendingApproval: null,
        startedAt: 1,
      };
      expect(run.steps).toHaveLength(1);
      expect(run.state).toBe('running');
    });

    it('RUN-SCHEMA-002: schema source contains no node:* / electron imports (renderer-safe)', async () => {
      // Resolve the schema file relative to THIS test file. We use
      // `import.meta.url` (ESM) rather than `__dirname` because the project
      // is configured with `"module": "ESNext"`.
      const here = dirname(fileURLToPath(import.meta.url));
      const path = resolve(here, '../../src/shared/schema/run.ts');
      const text = await fs.readFile(path, 'utf8');
      // Forbid Node-only / Electron-only specifiers — the schema is consumed
      // from `shared/ipc.ts` which is bundled into the renderer.
      expect(text).not.toMatch(/from\s+['"]node:/);
      expect(text).not.toMatch(/from\s+['"]electron['"]/);
      // Bare-specifier Node builtins (e.g. `from 'fs'` / `from 'path'`) too —
      // covers older import styles.
      expect(text).not.toMatch(/from\s+['"](?:fs|path|crypto|os|child_process|stream)['"]/);
    });
  });
});
