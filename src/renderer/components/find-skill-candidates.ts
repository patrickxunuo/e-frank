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

/**
 * Markdown list-item pattern Claude tends to emit even when we ask for
 * JSON. Captures lines like:
 *   - `frontend-design` — distinctive, production-grade UI...
 *   - `design-dna` - extract a design system from references
 *   - `arrange`: fix layout
 *   * `polish` — final alignment sweep
 *
 * Tolerates `-`, `*`, `•` bullets; backticks around the ref; `:`, `-`,
 * or em-dash (`—` / `–`) as the separator between ref + description.
 *
 * The ref must look like an installable skill name (kebab-case + the
 * `plugin:skill` form) so we don't pick up arbitrary code spans.
 */
const MARKDOWN_LINE_RE =
  /^[\s]*[-*•]\s+`([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)`\s*[:—–-]\s*(.+?)\s*$/i;

function extractFromMarkdown(output: string): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const m = MARKDOWN_LINE_RE.exec(line);
    if (m === null) continue;
    const ref = m[1]?.trim();
    const description = m[2]?.trim() ?? '';
    if (ref === undefined || ref === '' || seen.has(ref)) continue;
    seen.add(ref);
    // Claude's prose doesn't usually carry a separate name field —
    // use the ref as the display name. Looks reasonable in cards
    // (e.g. "frontend-design") and is how the skills page itself
    // labels installed skills today.
    candidates.push({ name: ref, ref, description, stars: null });
  }
  return candidates;
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_CELL_RE = /^:?-+:?$/;
const INSTALL_COUNT_RE = /^(\d+(?:\.\d+)?)\s*([KkMmBb])?$/;
const REF_FULL_RE = /^[a-zA-Z0-9][\w.-]*\/[\w.-]+@[\w.-]+$/;
const REF_REPO_RE = /^[a-zA-Z0-9][\w.-]*\/[\w.-]+$/;
const IDENT_RE = /^[a-zA-Z][\w-]*$/;

function parseRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function cleanCell(cell: string): string {
  // Strip surrounding markdown bold + code-span markers.
  return cell.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function parseInstallsCount(text: string): number | null {
  const m = INSTALL_COUNT_RE.exec(text.trim());
  if (m === null) return null;
  const base = parseFloat(m[1] ?? '');
  if (!Number.isFinite(base)) return null;
  const suffix = (m[2] ?? '').toLowerCase();
  const multiplier =
    suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
  return Math.max(0, Math.floor(base * multiplier));
}

function pickDescription(cells: string[], exclude: Set<string>): string {
  // Longest cell that isn't the ref/name/installs-count.
  let best = '';
  for (const c of cells) {
    if (exclude.has(c)) continue;
    if (INSTALL_COUNT_RE.test(c)) continue;
    if (c.length > best.length) best = c;
  }
  return best;
}

function pickStars(cells: string[]): number | null {
  for (const c of cells) {
    if (!INSTALL_COUNT_RE.test(c)) continue;
    const n = parseInstallsCount(c);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Identify the candidate in a single table row by inspecting the
 * *shape* of each cell rather than relying on the header text. Claude
 * uses wildly inconsistent header words ("Skill", "Mark", "Purpose",
 * "Vibe", …) and inconsistent column layouts (4-col split vs 3-col
 * where the skill column already carries a full `owner/repo@skill`
 * ref). Header-driven detection breaks on every shape it wasn't
 * specifically tuned for — see CANDIDATE-PARSE-019/020.
 *
 *   Pass 1 — a cell already in `owner/repo@skill` form is the install
 *            ref. Name = the part after the last `@`.
 *   Pass 2 — `owner/repo` cell + a sibling identifier cell → compose
 *            `{repo}@{name}` (matches `npx skills add` syntax).
 *   Pass 3 — identifier cell alone (the skill is registry-resolved by
 *            its bare name, e.g. `find-skills`).
 */
function extractCandidateFromRow(cells: string[]): SkillCandidate | null {
  const cleaned = cells.map(cleanCell);

  for (const c of cleaned) {
    if (REF_FULL_RE.test(c)) {
      const atIdx = c.lastIndexOf('@');
      const name = c.slice(atIdx + 1);
      return {
        name,
        ref: c,
        description: pickDescription(cleaned, new Set([c])),
        stars: pickStars(cleaned),
      };
    }
  }

  let repo: string | null = null;
  let identName: string | null = null;
  for (const c of cleaned) {
    if (repo === null && REF_REPO_RE.test(c)) {
      repo = c;
      continue;
    }
    if (identName === null && IDENT_RE.test(c)) {
      identName = c;
    }
  }
  if (repo !== null && identName !== null) {
    const ref = `${repo}@${identName}`;
    return {
      name: identName,
      ref,
      description: pickDescription(cleaned, new Set([repo, identName])),
      stars: pickStars(cleaned),
    };
  }
  if (identName !== null) {
    return {
      name: identName,
      ref: identName,
      description: pickDescription(cleaned, new Set([identName])),
      stars: pickStars(cleaned),
    };
  }
  return null;
}

/**
 * Pull skill candidates out of the first markdown table in `output`.
 * Detection is anchored on the separator row (`|---|---|...`) — any
 * line above that with `|...|` shape is the header; subsequent `|...|`
 * lines (until the first non-table line) are data rows. Row parsing
 * is fully data-driven (see `extractCandidateFromRow`), so we tolerate
 * arbitrary header words and column counts (≥2) from Claude.
 */
function extractFromMarkdownTable(output: string): SkillCandidate[] {
  const lines = output.split('\n').map((l) => l.trim());

  let sepIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!TABLE_ROW_RE.test(line)) continue;
    const above = lines[i - 1] ?? '';
    if (!TABLE_ROW_RE.test(above)) continue;
    const sepCells = parseRow(line);
    if (sepCells.length === 0) continue;
    if (!sepCells.every((c) => TABLE_SEP_CELL_RE.test(c))) continue;
    sepIdx = i;
    break;
  }
  if (sepIdx === -1) return [];

  const candidates: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!TABLE_ROW_RE.test(line)) break;
    const cells = parseRow(line);
    const c = extractCandidateFromRow(cells);
    if (c === null || seen.has(c.ref)) continue;
    seen.add(c.ref);
    candidates.push(c);
  }
  return candidates;
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
  if (start !== -1 && end !== -1 && end > start) {
    const slice = stripped.slice(start, end + 1);
    let raw: unknown;
    try {
      raw = JSON.parse(slice);
    } catch {
      raw = null;
    }
    if (Array.isArray(raw)) {
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
        const stars = isFiniteNumber(obj['stars'])
          ? Math.max(0, Math.floor(obj['stars']))
          : null;
        candidates.push({ name, ref, description, stars });
      }
      return { candidates, parsed: true };
    }
  }

  // Fallback A: Claude returned a markdown table. Common shape:
  //   | Skill | Source | Installs | What it does |
  //   |---|---|---|---|
  //   | **find-skills** | `vercel-labs/skills` | 1.5M | ... |
  const fromTable = extractFromMarkdownTable(stripped);
  if (fromTable.length > 0) {
    return { candidates: fromTable, parsed: true };
  }

  // Fallback B: Claude returned a bulleted list of `ref` — description
  // lines (the portfolio-designer query format).
  const fromMarkdown = extractFromMarkdown(stripped);
  if (fromMarkdown.length > 0) {
    return { candidates: fromMarkdown, parsed: true };
  }

  return { candidates: [], parsed: false };
}
