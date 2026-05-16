/**
 * Prose-question detector (#GH-88).
 *
 * Sibling failure mode to #GH-73 (orphan EF_APPROVAL_REQUEST). When
 * Claude ends a run by asking a question in prose instead of emitting
 * a structured approval marker, the runner has no way to surface the
 * question — the run silently completes as `done` with no changes and
 * the user is left wondering what happened.
 *
 * This module is the v0 heuristic fallback the runner uses at exit
 * time. It scans the tail of Claude's stdout buffer for patterns that
 * suggest an unstructured question, returning a match + excerpt the
 * runner embeds in its `UnstructuredQuestionError` message.
 *
 * Pure module — no Electron / no IPC / no runner deps. Easy to test
 * head-to-head against real claude output captures.
 *
 * The proper structural fix lives in #GH-76 (PTY-based interactive
 * Claude). When that ships, this detector can go.
 */

/** Number of trailing non-empty lines we scan for patterns. */
const TAIL_LINES = 10;

/**
 * Number of trailing non-empty lines we include in the error message.
 * Matches `TAIL_LINES` so a match found near the top of the scan window
 * is still inside the excerpt — earlier mismatch would have hidden the
 * trigger text from the error message.
 */
const EXCERPT_LINES = TAIL_LINES;

/**
 * Lettered options like `A) Foo`, `B) Bar`. The capital-letter
 * + uppercase-start requirement is intentional — `a) lowercase` or
 * `(a)` parenthesized form, which are far more common in narrative
 * prose, don't trigger.
 */
const OPTION_LETTER_REGEX = /\b[A-E]\)\s+[A-Z]/;

/**
 * Numbered list of options. Per-line check: the line must START with
 * `1.` / `2.` / etc. followed by space + capital. We require the buffer
 * to have at least two such lines to avoid hitting on a single "1.
 * Done" status entry.
 */
const OPTION_NUMBER_REGEX = /^\s*[1-9]\.\s+[A-Z]/;

/**
 * Direct-question phrases that explicitly defer the decision to the
 * caller. Anchored on a `?` within the same prose fragment so a
 * declarative "I would like to..." doesn't match.
 */
const DIRECT_QUESTION_REGEX =
  /\b(would you like|do you want|should i|which (would|do) you|let me know|please confirm)\b[^?]*\?/i;

/**
 * Uncertainty phrases — when Claude punts because the spec is
 * ambiguous rather than offering choices.
 */
const UNCERTAINTY_REGEX =
  /\b(i need (you|more info|clarification)|i'?m not sure|could you (clarify|tell me))\b[^?]*\?/i;

// Note: an earlier draft used a regex over `<<<EF_PHASE>>>...creatingPr...
// <<<END_EF_PHASE>>>` substrings in the buffer as the escape hatch. That
// was dead code in practice — `WorkflowRunner.handleClaudeLine` consumes
// (slices out) every well-formed phase marker the moment it's parsed, so
// by the time the runner calls this detector at exit time, no creatingPr
// marker is left in the buffer to match. The escape hatch now flows
// through the explicit `prAlreadyCreated` parameter below: the runner
// passes `true` when `ctx.run.prUrl` is set (the creatingPr marker DID
// arrive earlier in the run; we just can't see it in the buffer
// anymore).

export interface ProseQuestionMatch {
  match: true;
  /** Trailing-lines excerpt the runner embeds in the error message. */
  excerpt: string;
  /** Which detector rule fired — useful for tests + telemetry. */
  trigger:
    | 'lettered-options'
    | 'numbered-options'
    | 'direct-question'
    | 'uncertainty';
}

export interface NoProseQuestionMatch {
  match: false;
}

export type ProseQuestionResult = ProseQuestionMatch | NoProseQuestionMatch;

/**
 * Return only the last `n` non-empty lines of `buffer`, in original
 * order. Used to build both the scan window AND the excerpt.
 */
function tailLines(buffer: string, n: number): string[] {
  const all = buffer.split(/\r?\n/);
  const out: string[] = [];
  for (let i = all.length - 1; i >= 0 && out.length < n; i--) {
    const line = all[i];
    if (line !== undefined && line.trim() !== '') out.push(line);
  }
  return out.reverse();
}

export interface DetectProseQuestionOptions {
  /**
   * If true, suppress all matches — the workflow already produced a
   * PR, so any trailing question text is post-completion narrative and
   * shouldn't fail the run. The runner passes `ctx.run.prUrl !== null`
   * for this; pure-module callers (tests) supply directly.
   */
  prAlreadyCreated?: boolean;
}

/**
 * Heuristic detector. Returns `{match: true, ...}` if the tail of
 * `buffer` looks like Claude asking a question, else `{match: false}`.
 *
 * Behavior:
 *   - Short-circuit `match: false` when `prAlreadyCreated` is true —
 *     the workflow shipped a PR so trailing prose can't be a blocker.
 *   - Scan only the last TAIL_LINES non-empty lines (joined with `\n`).
 *   - For lettered + numbered triggers, ALSO require a `?` somewhere
 *     in the tail window — defends against Claude's narrative-summary
 *     "1. Read auth.ts / 2. Patched validate()" end-of-run shape.
 *   - For direct-question + uncertainty triggers the `?` is baked into
 *     the regex.
 *   - First trigger wins.
 *
 * Note on the buffer: `WorkflowRunner.handleClaudeLine` strips well-
 * formed phase markers as they're consumed, so by the time the runner
 * passes `ctx.outputBuffer` here, none of the `<<<EF_PHASE>>>...
 * <<<END_EF_PHASE>>>` markers should appear in the buffer. That's why
 * the PR-already-created escape lives on the options bag instead of as
 * a buffer-scan.
 */
export function detectProseQuestion(
  buffer: string,
  options: DetectProseQuestionOptions = {},
): ProseQuestionResult {
  if (options.prAlreadyCreated === true) return { match: false };
  if (buffer === '') return { match: false };

  const tail = tailLines(buffer, TAIL_LINES);
  if (tail.length === 0) return { match: false };
  const joinedTail = tail.join('\n');
  const tailHasQuestionMark = joinedTail.includes('?');

  let trigger: ProseQuestionMatch['trigger'] | null = null;

  if (tailHasQuestionMark && OPTION_LETTER_REGEX.test(joinedTail)) {
    trigger = 'lettered-options';
  } else {
    const numberedHits = tail.filter((l) => OPTION_NUMBER_REGEX.test(l));
    if (numberedHits.length >= 2 && tailHasQuestionMark) {
      trigger = 'numbered-options';
    } else if (DIRECT_QUESTION_REGEX.test(joinedTail)) {
      trigger = 'direct-question';
    } else if (UNCERTAINTY_REGEX.test(joinedTail)) {
      trigger = 'uncertainty';
    }
  }

  if (trigger === null) return { match: false };

  const excerpt = tailLines(buffer, EXCERPT_LINES).join('\n');
  return { match: true, excerpt, trigger };
}
