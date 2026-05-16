import { describe, expect, it } from 'vitest';
import { detectProseQuestion } from '../../src/main/modules/prose-question-detector';

/**
 * PROSE-QUESTION-001..010 — heuristic detector for unstructured
 * Claude-asks-a-question failures (#GH-88).
 *
 * The detector is intentionally fuzzy. These tests pin the four
 * trigger paths + the false-positive escape hatch + a few
 * intentionally-NOT-matching shapes so the regex stays bounded.
 */

describe('detectProseQuestion', () => {
  it('PROSE-QUESTION-001: empty buffer → no match', () => {
    expect(detectProseQuestion('')).toEqual({ match: false });
  });

  it('PROSE-QUESTION-002: lettered options A) and B) at end → match (lettered-options)', () => {
    const buf = [
      'Implemented the basic shell.',
      "I see two ways to handle validation:",
      "A) Strict RFC 5322",
      "B) Loose @-and-dot check",
      'Which would you like?',
    ].join('\n');
    const r = detectProseQuestion(buf);
    expect(r.match).toBe(true);
    if (!r.match) return;
    expect(r.trigger).toBe('lettered-options');
    expect(r.excerpt).toContain('A) Strict');
    expect(r.excerpt).toContain('B) Loose');
  });

  it('PROSE-QUESTION-003: numbered options + trailing ? → match (numbered-options)', () => {
    // The `?` requirement defends against Claude's end-of-run narrative
    // summary shape ("1. Read auth.ts / 2. Patched validate()") which
    // happens to look like a numbered list. We require an actual
    // question mark somewhere in the tail window to fire.
    const buf = [
      'Set up the project scaffold.',
      'I am unsure which approach to take:',
      '1. Add the new column with a default',
      '2. Add the new column nullable + backfill',
      '3. Wait for the migration window',
      'Which would you choose?',
    ].join('\n');
    const r = detectProseQuestion(buf);
    expect(r.match).toBe(true);
    if (!r.match) return;
    expect(r.trigger).toBe('numbered-options');
  });

  it('PROSE-QUESTION-003b: numbered narrative summary WITHOUT a ? → NO match (regression guard against summary lists)', () => {
    // The end-of-run summary shape that motivated the tightening.
    // Should remain a `done` run, not a `failed` run.
    const buf = [
      'Implemented the feature.',
      'Steps performed:',
      '1. Added validation to src/auth.ts',
      '2. Patched the test fixtures',
      '3. Updated the changelog',
      'All tests pass.',
    ].join('\n');
    expect(detectProseQuestion(buf)).toEqual({ match: false });
  });

  it('PROSE-QUESTION-004: "Should I..." phrase → match (direct-question)', () => {
    const buf = [
      'Read all the relevant files.',
      'Found the auth middleware at src/middleware/auth.ts.',
      'Should I rewrite it from scratch or refactor in place?',
    ].join('\n');
    const r = detectProseQuestion(buf);
    expect(r.match).toBe(true);
    if (!r.match) return;
    expect(r.trigger).toBe('direct-question');
  });

  it('PROSE-QUESTION-005: "Would you like..." phrase → match', () => {
    const buf = [
      'Drafted the changes.',
      'Would you like me to proceed with the merge?',
    ].join('\n');
    const r = detectProseQuestion(buf);
    expect(r.match).toBe(true);
    if (!r.match) return;
    expect(r.trigger).toBe('direct-question');
  });

  it('PROSE-QUESTION-006: "I am not sure..." + question mark → match (uncertainty)', () => {
    const buf = [
      "I'm not sure which database we should target for this fix — could you clarify?",
    ].join('\n');
    const r = detectProseQuestion(buf);
    expect(r.match).toBe(true);
    if (!r.match) return;
    expect(r.trigger).toBe('uncertainty');
  });

  it('PROSE-QUESTION-007: normal narrative mentioning "options A and B" → NO match (false-positive guard)', () => {
    // Reads like a casual mention, not an actionable question. We
    // do NOT want to fail healthy runs that happen to discuss options.
    const buf = [
      'Reviewed the candidate solutions: option a vs option b.',
      'Picked option b based on the existing test patterns.',
      'Committed the change as feat(GH-99): add validation.',
      'All tests pass.',
    ].join('\n');
    expect(detectProseQuestion(buf)).toEqual({ match: false });
  });

  it('PROSE-QUESTION-008: prAlreadyCreated option suppresses any match (workflow-completed escape hatch)', () => {
    // Claude saw the options, asked, then proceeded anyway — by the
    // time the run ends, a PR exists. The runner passes
    // `prAlreadyCreated: true` based on `ctx.run.prUrl`, since by
    // exit-time the marker has already been consumed (stripped) from
    // the outputBuffer.
    const buf = [
      "I see two ways:",
      "A) Refactor in place",
      "B) Rewrite from scratch",
      'I will go with A.',
      'Committed and pushed.',
      'PR opened.',
      'Which would you prefer next time?',
    ].join('\n');
    // Without the flag the detector fires.
    expect(detectProseQuestion(buf).match).toBe(true);
    // With the flag set (runner has prUrl) it's a no-op.
    expect(detectProseQuestion(buf, { prAlreadyCreated: true })).toEqual({
      match: false,
    });
  });

  it('PROSE-QUESTION-009: a single "1. " line is NOT a numbered question (needs ≥2 lines)', () => {
    const buf = [
      'Started run.',
      '1. Setup completed.',
    ].join('\n');
    expect(detectProseQuestion(buf)).toEqual({ match: false });
  });

  it('PROSE-QUESTION-010: excerpt is bounded to last ~10 non-empty lines and contains the trigger', () => {
    const buf = [
      'pre-window filler 1',
      'pre-window filler 2',
      'pre-window filler 3',
      'pre-window filler 4',
      'pre-window filler 5',
      'older line 1',
      'older line 2',
      'older line 3',
      'older line 4',
      'older line 5',
      'older line 6',
      'older line 7',
      'older line 8',
      'A) First option',
      'B) Second option',
      'Which would you prefer?',
    ].join('\n');
    const r = detectProseQuestion(buf);
    expect(r.match).toBe(true);
    if (!r.match) return;
    // Excerpt should include the trigger question AND the trigger
    // substring (`A) First option`), but stop short of the very first
    // pre-window filler lines.
    expect(r.excerpt).toContain('Which would you prefer?');
    expect(r.excerpt).toContain('A) First option');
    expect(r.excerpt).not.toContain('pre-window filler 1');
  });
});
