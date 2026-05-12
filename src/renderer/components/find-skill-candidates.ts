/**
 * `parseSkillCandidates` — extract a structured list of skill candidates
 * from Claude's streamed `/find-skills` output.
 *
 * The SkillFinder is now driven by a prompt that asks Claude to respond
 * with a JSON array (see `skill-finder.ts buildFindSkillsPrompt`). This
 * parser is the renderer-side counterpart: it pulls the first JSON
 * array out of the accumulated stdout and validates each item's shape.
 *
 * Robustness rules — Claude WILL occasionally:
 *   - Wrap the JSON in a markdown code fence (```json ... ```)
 *   - Add a leading sentence like "Here are some skills:" before the [
 *   - Add a trailing sentence after the ]
 *   - Forget to emit JSON entirely and ramble in prose
 *
 * The parser handles the first three by slicing the substring from the
 * first `[` to the last `]` and stripping fence backticks first. The
 * fourth case returns `parsed: false` so the dialog can fall back to
 * the raw-stream view + the manual install input.
 *
 * Each candidate must carry `name` + `ref` (those drive the card title
 * + the Install button); `description` and `stars` are optional and
 * default to empty / null when missing.
 */

export interface SkillCandidate {
  /** Display name shown in the card title. */
  name: string;
  /** Install reference passed to `npx skills add`. */
  ref: string;
  /** One-line description, may be empty. */
  description: string;
  /** GitHub stars if Claude knew them, else null (rendered as `—`). */
  stars: number | null;
}

export interface ParseResult {
  /** Validated candidates. Empty if `parsed: false` or array was empty. */
  candidates: SkillCandidate[];
  /** True if we found + parsed a JSON array. False ⇒ show raw stream. */
  parsed: boolean;
}

const FENCE_OPEN = /```(?:json|JSON)?\s*/g;
const FENCE_CLOSE = /\s*```\s*/g;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function parseSkillCandidates(output: string): ParseResult {
  if (output === '') {
    return { candidates: [], parsed: false };
  }
  // Strip markdown code fences (open + close) so the first/last `[`/`]`
  // we hunt for is the actual array delimiter, not a fence artifact.
  const stripped = output.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '');
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return { candidates: [], parsed: false };
  }
  const slice = stripped.slice(start, end + 1);

  let raw: unknown;
  try {
    raw = JSON.parse(slice);
  } catch {
    return { candidates: [], parsed: false };
  }
  if (!Array.isArray(raw)) {
    return { candidates: [], parsed: false };
  }

  const candidates: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
    const ref = typeof obj['ref'] === 'string' ? obj['ref'].trim() : '';
    if (name === '' || ref === '') continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const description =
      typeof obj['description'] === 'string' ? obj['description'].trim() : '';
    const stars = isFiniteNumber(obj['stars']) ? Math.max(0, Math.floor(obj['stars'])) : null;
    candidates.push({ name, ref, description, stars });
  }

  return { candidates, parsed: true };
}
