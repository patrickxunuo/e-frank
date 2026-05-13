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
 * Conservative renderer/main-side filler stripper. Telling Claude in
 * the prompt to "strip filler phrases" was unreliable — for verbose
 * queries like "find a skill that can create jira issue", Claude
 * would latch onto "find" as the literal search keyword and surface
 * skills whose *names* contain "find" (find-bugs, find-keywords, …)
 * instead of skills relevant to the actual task. By stripping the
 * filler deterministically here, Claude never sees the verbose
 * meta-language and matches on the real intent ("create jira issue").
 *
 * Rules are conservative — patterns only strip well-formed leading
 * "find a skill that…" / "I need a skill to…" wrappers and trailing
 * "for me" / "please". Anything that doesn't match a rule passes
 * through untouched. If stripping would leave an empty string, the
 * original query is returned (defensive — never send "" to Claude).
 *
 * Exported for unit testing.
 */
export function stripQueryFiller(q: string): string {
  const trimmed = q.trim();
  let result = trimmed;
  for (const re of STRIP_RULES) {
    result = result.replace(re, '');
  }
  result = result.trim();
  return result === '' ? trimmed : result;
}

const STRIP_RULES: ReadonlyArray<RegExp> = [
  // Leading: "find [me] [a/an/the] skill[s] [that/which/to/for] [can/will]"
  /^find\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?skills?(?:\s+(?:that|which|to|for))?(?:\s+(?:can|will))?\s+/i,
  // Leading: "I [need/want/am looking for] [a/an/the] skill[s] [that/which/to/for] [can/will]"
  /^i('?m)?\s+(?:need|want|am\s+looking\s+for)\s+(?:a\s+|an\s+|the\s+)?skills?(?:\s+(?:that|which|to|for))?(?:\s+(?:can|will))?\s+/i,
  // Leading: "help me [find] [a/an/the] skill[s] [that/to/for] [can/will]"
  /^help\s+me\s+(?:find\s+)?(?:a\s+|an\s+|the\s+)?skills?(?:\s+(?:that|which|to|for))?(?:\s+(?:can|will))?\s+/i,
  // Leading: "show/give/suggest/recommend me [a/an/the] skill[s] [that/to/for] [can/will]"
  /^(?:show|give|suggest|recommend)\s+me\s+(?:a\s+|an\s+|the\s+)?skills?(?:\s+(?:that|which|to|for))?(?:\s+(?:can|will))?\s+/i,
  // Trailing "for me" / "please"
  /\s+for\s+me\s*$/i,
  /\s+please\s*$/i,
];

/**
 * Build the prompt Claude receives. The cleaned query is positioned
 * as a task description, not a search term — earlier "Search for
 * skills matching ..." shapes caused Claude to latch onto literal
 * words and surface skills whose *names* contained the query
 * keywords (e.g. find-bugs, find-keywords for any query starting
 * with "find"). Reframing as "the user wants to do this task"
 * pushes Claude toward intent matching even on edge cases
 * stripQueryFiller missed.
 *
 * Shell-safety constraint: the prompt MUST be a single line with NO
 * embedded double-quote characters. NodeSpawner runs with shell:true
 * on Windows; cmd.exe wraps args containing spaces in outer "..." and
 * an embedded " inside the prompt closes the outer wrap prematurely,
 * splitting the prompt into fragments — at which point claude
 * receives only a stub and responds "I'm ready to help. What would
 * you like me to work on?". Embedded \n triggers a cmd.exe command-
 * line break with similar fragmentation. We sidestep both by joining
 * clauses with ". " (period + space) and using single quotes (or no
 * quotes) around query boundaries inside the prompt.
 *
 * The `skillName` param is preserved for forward-compat / overrides
 * but isn't embedded in the default prompt body.
 */
export function buildFindSkillsPrompt(_skillName: string, query: string): string {
  const cleaned = stripQueryFiller(query);
  return (
    `The user wants help with this task: '${cleaned}'. ` +
    `Recommend up to 5 Claude Code skills that would help DO this task. ` +
    `Treat the quoted text as a description of intent, NOT as a literal keyword search — do not match on filler words like 'find', 'skill', or 'tool', match on what the user actually wants to accomplish. ` +
    `Use the /find-skills slash command with the key task terms (the verbs and nouns from the request, e.g. 'create jira ticket', 'deploy to fly.io') to query the registry. ` +
    `Rank by relevance to the underlying task; a skill whose name matches a filler word is not a hit unless it actually does the task. ` +
    `Output a JSON array of objects with these fields: name (string), ref (string, prefer owner/repo@skill form like vercel-labs/skills@frontend-design), description (one line max 120 chars), stars (number or null). ` +
    `A markdown table or bulleted list with the same fields is also accepted. ` +
    `Do not ask clarifying questions. If nothing in the registry fits, return an empty list. ` +
    `Example: [{name: frontend-design, ref: vercel-labs/skills@frontend-design, description: Distinctive production-grade UI, stars: 42}]`
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
