/**
 * SKILL-MARKERS — static-analysis guard against drift between the skill's
 * emitted phase markers and the runner's `PHASE_VALUES` set.
 *
 * The contract: every `<<<EF_PHASE>>>{"phase":"X"}<<<END_EF_PHASE>>>`
 * marker the skill emits must name a phase the runner is willing to enter,
 * otherwise the runner logs a warn and silently drops the marker — making
 * the timeline lie to the user. This test reads the SKILL.md as a string,
 * pulls every `phase` value out of the marker emissions, and asserts each
 * one is a member of the runner's `RunState` union via the schema's exact
 * literal list.
 *
 * Doesn't actually run the runner — pure file I/O. Catches drift introduced
 * by either side without needing a real `claude` binary.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The set of phase values the runner whitelists. Hand-mirrored from
// `PHASE_VALUES` in workflow-runner.ts (private constant). The whole point
// of this test is to catch drift between SKILL.md and that constant — if
// you add a phase to PHASE_VALUES, add it here too.
const RUNNER_PHASE_VALUES: ReadonlySet<string> = new Set([
  'fetchingTicket',
  'branching',
  'understandingContext',
  'planning',
  'implementing',
  'evaluatingTests',
  'reviewingCode',
  'committing',
  'pushing',
  'creatingPr',
  'updatingTicket',
]);

const SKILL_PATHS = [
  resolve(__dirname, '../../.claude/skills/ef-auto-feature/SKILL.md'),
];

// Marker shape: <<<EF_PHASE>>>{"phase":"..."}<<<END_EF_PHASE>>>
//
// SKILL.md emits markers from inside double-quoted bash strings, so the
// inner double quotes appear escaped: `\"phase\":\"branching\"`. Plain
// single-quoted bash strings (e.g. `echo '<<<EF_PHASE>>>{"phase":"x"}…'`)
// preserve the unescaped form. The regex tolerates both by allowing an
// optional backslash before each inner quote.
const MARKER_RE =
  /<<<EF_PHASE>>>[^<]*?\\?"phase\\?"\s*:\s*\\?"([a-zA-Z0-9_]+)\\?"[^<]*?<<<END_EF_PHASE>>>/g;

function extractPhaseValues(content: string): string[] {
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(content)) !== null) {
    if (match[1] !== undefined) {
      values.push(match[1]);
    }
  }
  return values;
}

describe('SKILL-MARKERS', () => {
  for (const skillPath of SKILL_PATHS) {
    describe(`${skillPath.split(/[\\/]+/).slice(-3).join('/')}`, () => {
      const content = readFileSync(skillPath, 'utf8');
      const phaseValues = extractPhaseValues(content);

      it('SKILL-MARKERS-001: file contains at least one phase marker', () => {
        // The skill is supposed to drive the runner's UI timeline — it
        // would be a regression if SKILL.md emitted no markers at all.
        expect(phaseValues.length).toBeGreaterThan(0);
      });

      it('SKILL-MARKERS-002: every emitted phase value is in PHASE_VALUES', () => {
        const unknown = phaseValues.filter(
          (p) => !RUNNER_PHASE_VALUES.has(p),
        );
        // Print the actual offenders in the error message — much faster
        // diagnosis than `expect(unknown.length).toBe(0)` alone.
        expect(unknown, `unknown phase values in SKILL.md: ${unknown.join(', ')}`).toEqual([]);
      });

      it('SKILL-MARKERS-003: every PHASE_VALUE the runner accepts is emitted somewhere in SKILL.md', () => {
        // Catches the inverse drift — runner accepts a phase but skill
        // never emits it (dead branch in the runner). The runner-side
        // PHASE_VALUES is the same constant that filters incoming
        // markers, so any phase listed there should be reachable from
        // SKILL.md or we have unused state-machine surface.
        const emitted = new Set(phaseValues);
        const missing: string[] = [];
        for (const expected of RUNNER_PHASE_VALUES) {
          if (!emitted.has(expected)) missing.push(expected);
        }
        expect(missing, `phases accepted by runner but never emitted by SKILL.md: ${missing.join(', ')}`).toEqual([]);
      });
    });
  }
});
