/**
 * SkillFinder — spawn `claude` with a structured-output prompt that
 * asks it to invoke `/find-skills <query>` internally and respond ONLY
 * with a JSON array of candidates. The renderer parses that array via
 * `parseSkillCandidates` and renders the results as a card grid.
 *
 * Deliberately separate from `ClaudeProcessManager` (which guards a
 * single active workflow run): the user must be able to search for
 * skills while a workflow run is in flight. Both managers share the
 * `Spawner` abstraction, so they can be tested with `FakeSpawner`
 * independently.
 *
 * Single-active-find guard: `start()` rejects with `FIND_ALREADY_ACTIVE`
 * if a find is in flight. Renderer-side UX is to disable the search
 * button while `findId` is set.
 *
 * Line-buffered stdout/stderr. The renderer accumulates lines and runs
 * `parseSkillCandidates` to pick out the JSON array; if Claude rambles
 * instead of emitting JSON, the renderer falls back to a raw-stream
 * view with a manual install input.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Spawner, SpawnedProcess } from './spawner.js';

const DEFAULT_COMMAND = 'claude';
const DEFAULT_SKILL_NAME = 'find-skills';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Build the prompt Claude receives. Asks Claude directly for skill
 * recommendations with a strict JSON-array output format. Single-line
 * so cmd.exe / `shell: true` quoting doesn't get confused by embedded
 * newlines inside the argv element.
 *
 * Why no `/find-skills` slash-command wrapper here: in practice, the
 * slash-command output short-circuits Claude's response — it returns
 * the prose-formatted output from the skill verbatim and ignores the
 * "Respond ONLY with JSON" instruction, defeating the parser. Asking
 * Claude directly for a recommendation lets the structured-output
 * directive actually stick. Claude's general knowledge of public
 * Claude Code skills covers the common case; users who want a
 * specific ref the model doesn't recall can paste it into the manual
 * install input.
 *
 * Exported so unit tests can assert against the prompt string without
 * having to inspect a mocked spawn call's args.
 *
 * The `skillName` param is kept for forward-compat / overrides but is
 * no longer used in the default prompt — callers that DO want the
 * slash-command path can pass a custom prompt builder via the
 * SkillFinder options if it becomes useful later.
 */
export function buildFindSkillsPrompt(_skillName: string, query: string): string {
  const q = query.trim();
  // Prompt strategy: tell Claude to USE the /find-skills slash command
  // (which knows the real skill registry) rather than recall skills
  // from training memory. A previous iteration of this prompt forbade
  // "offering to invoke skills" in an attempt to stop chat-mode
  // responses, but that rule also blocked Claude from using
  // /find-skills as its own search tool — so it had no registry data
  // to draw from and returned `[]` every time. The format ask is
  // intentionally loose (JSON preferred, table/bullets acceptable)
  // because the renderer's parser handles all three shapes.
  return (
    `Search for Claude Code skills matching this user request: "${q}"\n\n` +
    `Steps:\n` +
    `1. Identify the underlying task. Strip filler phrases like "find a skill that can", "I need", "help me", "for me" — focus on what the user actually wants to accomplish (e.g. "find a skill that can design my personal portfolio" → "portfolio design").\n` +
    `2. Use the /find-skills slash command with the task keywords to query the actual skill registry. Don't rely on memory — use the registry.\n` +
    `3. Present up to 5 of the most relevant skills. Preferred format is a JSON array of {"name", "ref" (in "owner/repo@skill" form when applicable, e.g. "vercel-labs/skills@frontend-design"), "description" (one line, ≤120 chars), "stars" (number or null)}. A markdown table or bulleted list with the same fields is also acceptable.\n` +
    `4. Don't ask clarifying questions. If the registry returns nothing relevant, output an empty list.\n\n` +
    `Example JSON: [{"name":"frontend-design","ref":"vercel-labs/skills@frontend-design","description":"Distinctive production-grade UI","stars":42}]`
  );
}

export interface FinderOutputEvent {
  findId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: number;
}

export interface FinderExitEvent {
  findId: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  reason: 'completed' | 'cancelled' | 'error';
}

export interface SkillFinderOptions {
  spawner: Spawner;
  /** Working directory. Typically `app.getPath('userData')`. */
  cwd: string;
  /** Override the binary. Defaults to `claude`. */
  command?: string;
  /** Skill name without the leading slash. Defaults to `find-skills`. */
  skillName?: string;
  /** Hard timeout in ms. Defaults to 10 minutes. */
  timeoutMs?: number;
  /**
   * Override the flags list. Defaults to
   * `['--dangerously-skip-permissions', '-p']`. `-p` runs Claude in
   * print-mode (single-shot, exits when done).
   */
  flags?: ReadonlyArray<string>;
}

export interface ActiveFind {
  findId: string;
  pid: number | undefined;
  startedAt: number;
}

interface FindState {
  findId: string;
  startedAt: number;
  child: SpawnedProcess;
  stdoutBuffer: string;
  stderrBuffer: string;
  cancelled: boolean;
  timer: NodeJS.Timeout;
}

export class FinderAlreadyActiveError extends Error {
  readonly code = 'FIND_ALREADY_ACTIVE' as const;
  constructor() {
    super('A find-skills run is already in flight');
  }
}

export class FinderNotActiveError extends Error {
  readonly code = 'FIND_NOT_ACTIVE' as const;
  constructor(findId: string) {
    super(`No active find with id ${findId}`);
  }
}

export class SkillFinder extends EventEmitter {
  private readonly opts: Required<
    Pick<SkillFinderOptions, 'command' | 'skillName' | 'timeoutMs'>
  > & { flags: ReadonlyArray<string>; cwd: string; spawner: Spawner };

  private state: FindState | null = null;

  constructor(options: SkillFinderOptions) {
    super();
    this.opts = {
      command: options.command ?? DEFAULT_COMMAND,
      skillName: options.skillName ?? DEFAULT_SKILL_NAME,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      flags: options.flags ?? ['--dangerously-skip-permissions', '-p'],
      cwd: options.cwd,
      spawner: options.spawner,
    };
  }

  /** Returns the currently active find, or null if idle. */
  active(): ActiveFind | null {
    if (this.state === null) return null;
    return {
      findId: this.state.findId,
      pid: this.state.child.pid,
      startedAt: this.state.startedAt,
    };
  }

  start(query: string): ActiveFind {
    if (this.state !== null) throw new FinderAlreadyActiveError();
    const findId = randomUUID();
    const startedAt = Date.now();
    const prompt = buildFindSkillsPrompt(this.opts.skillName, query);
    const child = this.opts.spawner.spawn({
      command: this.opts.command,
      args: [...this.opts.flags, prompt],
      cwd: this.opts.cwd,
    });
    // Close stdin immediately so claude doesn't emit
    //   "Warning: no stdin data received in 3s, proceeding without it"
    // at the start of every find. With stdin closed, claude sees EOF
    // right away and skips the 3-second wait. We never write to the
    // finder's stdin — the prompt is passed as a `-p` argv positional.
    try {
      child.stdin?.end();
    } catch {
      // FakeSpawner's stdin is a no-op Writable; closing twice is
      // harmless. Real ChildProcess.stdin.end() can throw only if the
      // process exited synchronously between spawn and now, which is
      // already handled by the exit listener.
    }
    const timer = setTimeout(() => {
      this.handleTimeout();
    }, this.opts.timeoutMs);
    const state: FindState = {
      findId,
      startedAt,
      child,
      stdoutBuffer: '',
      stderrBuffer: '',
      cancelled: false,
      timer,
    };
    this.state = state;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      state.stdoutBuffer = this.drainLines(state.stdoutBuffer + text, 'stdout', state);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      state.stderrBuffer = this.drainLines(state.stderrBuffer + text, 'stderr', state);
    });

    child.on('exit', (code, signal) => {
      if (this.state !== state) return;
      this.flushTrailing(state);
      clearTimeout(state.timer);
      const reason: FinderExitEvent['reason'] = state.cancelled ? 'cancelled' : 'completed';
      this.emitExit(state, code, signal, reason);
      this.state = null;
    });

    child.on('error', (err) => {
      if (this.state !== state) return;
      // Surface as a stderr line then close as 'error'.
      this.emit('output', {
        findId: state.findId,
        stream: 'stderr',
        line: `[spawn error] ${err.message}`,
        timestamp: Date.now(),
      } satisfies FinderOutputEvent);
      this.flushTrailing(state);
      clearTimeout(state.timer);
      this.emitExit(state, null, null, 'error');
      this.state = null;
    });

    return {
      findId,
      pid: child.pid,
      startedAt,
    };
  }

  cancel(findId: string): void {
    if (this.state === null || this.state.findId !== findId) {
      throw new FinderNotActiveError(findId);
    }
    this.state.cancelled = true;
    try {
      this.state.child.kill('SIGTERM');
    } catch {
      // ignore — exit handler still fires
    }
  }

  private drainLines(buffer: string, stream: 'stdout' | 'stderr', state: FindState): string {
    let remaining = buffer;
    let nl = remaining.indexOf('\n');
    while (nl !== -1) {
      const raw = remaining.slice(0, nl);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      this.emit('output', {
        findId: state.findId,
        stream,
        line,
        timestamp: Date.now(),
      } satisfies FinderOutputEvent);
      remaining = remaining.slice(nl + 1);
      nl = remaining.indexOf('\n');
    }
    return remaining;
  }

  private flushTrailing(state: FindState): void {
    if (state.stdoutBuffer !== '') {
      this.emit('output', {
        findId: state.findId,
        stream: 'stdout',
        line: state.stdoutBuffer,
        timestamp: Date.now(),
      } satisfies FinderOutputEvent);
      state.stdoutBuffer = '';
    }
    if (state.stderrBuffer !== '') {
      this.emit('output', {
        findId: state.findId,
        stream: 'stderr',
        line: state.stderrBuffer,
        timestamp: Date.now(),
      } satisfies FinderOutputEvent);
      state.stderrBuffer = '';
    }
  }

  private emitExit(
    state: FindState,
    code: number | null,
    signal: NodeJS.Signals | null,
    reason: FinderExitEvent['reason'],
  ): void {
    this.emit('exit', {
      findId: state.findId,
      exitCode: code,
      signal: signal ?? null,
      durationMs: Date.now() - state.startedAt,
      reason,
    } satisfies FinderExitEvent);
  }

  private handleTimeout(): void {
    if (this.state === null) return;
    this.state.cancelled = true;
    try {
      this.state.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}
