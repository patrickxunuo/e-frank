import { describe, it, expect, beforeEach } from 'vitest';
import {
  SkillFinder,
  FinderAlreadyActiveError,
  FinderNotActiveError,
  buildFindSkillsPrompt,
  stripQueryFiller,
  type FinderOutputEvent,
  type FinderExitEvent,
} from '../../src/main/modules/skill-finder';
import { FakeSpawner } from '../../src/main/modules/spawner';

const CWD = '/abs/userData';

interface Captured {
  output: FinderOutputEvent[];
  exit: FinderExitEvent[];
}

function attach(finder: SkillFinder): Captured {
  const captured: Captured = { output: [], exit: [] };
  finder.on('output', (e) => captured.output.push(e));
  finder.on('exit', (e) => captured.exit.push(e));
  return captured;
}

describe('SkillFinder', () => {
  let spawner: FakeSpawner;
  let finder: SkillFinder;

  beforeEach(() => {
    spawner = new FakeSpawner();
    finder = new SkillFinder({ spawner, cwd: CWD });
  });

  it('FIND-001: spawns claude with the structured-output prompt and the dangerous flag', () => {
    finder.start('image cropping');
    const opts = spawner.lastOptions;
    expect(opts?.command).toBe('claude');
    expect(opts?.args?.[0]).toBe('--dangerously-skip-permissions');
    expect(opts?.args?.[1]).toBe('-p');
    // The prompt asks Claude for structured JSON recommendations
    // directly — no `/find-skills` slash-command wrapper. Assert the
    // query is embedded and the JSON-output directive is present.
    // Don't pin exact wording so prompt iterations don't break this
    // test for no reason.
    const prompt = opts?.args?.[2] ?? '';
    expect(prompt).toContain('image cropping');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain('"name"');
    expect(prompt).toContain('"ref"');
    expect(opts?.cwd).toBe(CWD);
  });

  it('FIND-002: line-buffers stdout across chunks', () => {
    const captured = attach(finder);
    finder.start('q');
    const proc = spawner.lastSpawned;
    proc?.emitStdout('Recommend');
    proc?.emitStdout('ation: foo\nNext line\n');
    const stdoutLines = captured.output
      .filter((e) => e.stream === 'stdout')
      .map((e) => e.line);
    expect(stdoutLines).toEqual(['Recommendation: foo', 'Next line']);
  });

  it('FIND-003: trailing partial line is flushed on exit', () => {
    const captured = attach(finder);
    finder.start('q');
    const proc = spawner.lastSpawned;
    proc?.emitStdout('partial-line');
    proc?.emitExit(0, null);
    const stdoutLines = captured.output
      .filter((e) => e.stream === 'stdout')
      .map((e) => e.line);
    expect(stdoutLines).toEqual(['partial-line']);
  });

  it('FIND-004: emits exit event with completed reason on clean exit', () => {
    const captured = attach(finder);
    const active = finder.start('q');
    spawner.lastSpawned?.emitExit(0, null);
    expect(captured.exit).toHaveLength(1);
    expect(captured.exit[0]).toMatchObject({
      findId: active.findId,
      exitCode: 0,
      reason: 'completed',
    });
    expect(typeof captured.exit[0]?.durationMs).toBe('number');
  });

  it('FIND-010: start while active throws FinderAlreadyActiveError', () => {
    finder.start('first');
    expect(() => finder.start('second')).toThrow(FinderAlreadyActiveError);
  });

  it('FIND-011: cancel kills child and emits cancelled-reason exit', () => {
    const captured = attach(finder);
    const active = finder.start('q');
    finder.cancel(active.findId);
    expect(spawner.lastSpawned?.lastSignal).toBe('SIGTERM');
    spawner.lastSpawned?.emitExit(null, 'SIGTERM');
    expect(captured.exit[0]).toMatchObject({
      findId: active.findId,
      reason: 'cancelled',
    });
  });

  it('FIND-012: cancel with wrong findId throws FinderNotActiveError', () => {
    finder.start('q');
    expect(() => finder.cancel('not-the-right-id')).toThrow(FinderNotActiveError);
  });

  it('FIND-013: cancel with no active find throws FinderNotActiveError', () => {
    expect(() => finder.cancel('anything')).toThrow(FinderNotActiveError);
  });

  it('FIND-020: spawn error emits stderr line and exit(reason=error)', () => {
    const captured = attach(finder);
    const active = finder.start('q');
    spawner.lastSpawned?.emitError(new Error('claude not found'));
    expect(captured.output.some((e) => e.line.includes('claude not found'))).toBe(true);
    expect(captured.exit[0]).toMatchObject({
      findId: active.findId,
      reason: 'error',
    });
  });

  it('FIND-021: after exit, finder is idle and a new find can start', () => {
    const a1 = finder.start('q1');
    spawner.lastSpawned?.emitExit(0, null);
    expect(finder.active()).toBeNull();
    const a2 = finder.start('q2');
    expect(a2.findId).not.toBe(a1.findId);
  });

  it('FIND-022: timeout kills the child', async () => {
    const finder2 = new SkillFinder({ spawner, cwd: CWD, timeoutMs: 5 });
    finder2.start('slow');
    // Wait microtask + 10ms for timer.
    await new Promise((r) => setTimeout(r, 15));
    expect(spawner.lastSpawned?.lastSignal).toBe('SIGTERM');
  });

  it('FIND-030: active() reports the running find', () => {
    const active = finder.start('q');
    expect(finder.active()).toEqual({
      findId: active.findId,
      pid: active.pid,
      startedAt: active.startedAt,
    });
  });

  it('FIND-031: stderr lines surface with stream=stderr', () => {
    const captured = attach(finder);
    finder.start('q');
    spawner.lastSpawned?.emitStderr('warn: x\n');
    expect(
      captured.output.filter((e) => e.stream === 'stderr').map((e) => e.line),
    ).toEqual(['warn: x']);
  });
});

/**
 * FIND-FILLER-001..010 — `stripQueryFiller` deterministically removes
 * the verbose "find a skill that can…" wrapper from user queries
 * before they reach Claude. Telling Claude in the prompt to do the
 * same was unreliable (Claude would treat "find" as the keyword and
 * surface unrelated skills whose names contain it).
 */
describe('stripQueryFiller', () => {
  it('FIND-FILLER-001: strips "find a skill that can …"', () => {
    expect(stripQueryFiller('find a skill that can create jira issue')).toBe('create jira issue');
  });

  it('FIND-FILLER-002: strips "find me a skill to …"', () => {
    expect(stripQueryFiller('find me a skill to design portfolio')).toBe('design portfolio');
  });

  it('FIND-FILLER-003: strips "I need a skill that can …"', () => {
    expect(stripQueryFiller('I need a skill that can edit images')).toBe('edit images');
  });

  it('FIND-FILLER-004: strips "help me find a skill for …"', () => {
    expect(stripQueryFiller('help me find a skill for testing')).toBe('testing');
  });

  it('FIND-FILLER-005: strips trailing "for me"', () => {
    expect(stripQueryFiller('design portfolio for me')).toBe('design portfolio');
  });

  it('FIND-FILLER-006: strips both leading wrapper + trailing "for me"', () => {
    expect(stripQueryFiller('find a skill that can design portfolio for me')).toBe(
      'design portfolio',
    );
  });

  it('FIND-FILLER-007: passes through queries that already look like keywords', () => {
    expect(stripQueryFiller('image cropping')).toBe('image cropping');
    expect(stripQueryFiller('deploy to fly.io')).toBe('deploy to fly.io');
  });

  it('FIND-FILLER-008: trims surrounding whitespace', () => {
    expect(stripQueryFiller('   testing   ')).toBe('testing');
  });

  it('FIND-FILLER-009: falls back to original when stripping would empty', () => {
    // "find a skill" with nothing after — stripping would leave "",
    // which is useless to Claude. Defensive fallback to the original.
    expect(stripQueryFiller('find a skill')).toBe('find a skill');
  });

  it('FIND-FILLER-010: handles plural / "skills" variants', () => {
    expect(stripQueryFiller('find skills that can deploy code')).toBe('deploy code');
    expect(stripQueryFiller('suggest me skills for code review')).toBe('code review');
  });
});

/**
 * FIND-PROMPT-001..002 — `buildFindSkillsPrompt` integrates the
 * filler stripping. Asserts the cleaned query (not the verbose
 * original) ends up embedded in the prompt body.
 */
describe('buildFindSkillsPrompt', () => {
  it('FIND-PROMPT-001: embeds the filler-stripped query, not the verbose original', () => {
    const prompt = buildFindSkillsPrompt('find-skills', 'find a skill that can create jira issue');
    expect(prompt).toContain('"create jira issue"');
    // Verbose original should NOT appear in the prompt body.
    expect(prompt).not.toContain('find a skill that can create jira issue');
  });

  it('FIND-PROMPT-002: passes simple queries through untouched', () => {
    const prompt = buildFindSkillsPrompt('find-skills', 'image cropping');
    expect(prompt).toContain('"image cropping"');
  });
});
