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
const INSTALL_COUNT_RE = /^(\d+(?:\.\d+)?)\s*([KkMmBb])?/;

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

/**
 * Claude's *other* favorite shape: a markdown table with columns like
 * `| Skill | Source | Installs | What it does |`. Header detection
 * maps cells to roles; rows compose `{source}@{name}` as the install
 * ref when source looks like a repo path (contains `/`), matching the
 * `npx skills add owner/repo@skill` convention.
 */
function extractFromMarkdownTable(output: string): SkillCandidate[] {
  const tableLines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => TABLE_ROW_RE.test(l));
  if (tableLines.length < 3) return [];

  const headerRow = tableLines[0];
  const sepRow = tableLines[1];
  if (headerRow === undefined || sepRow === undefined) return [];
  const header = parseRow(headerRow);
  const sep = parseRow(sepRow);
  if (sep.length === 0 || !sep.every((c) => TABLE_SEP_CELL_RE.test(c))) return [];

  const findCol = (re: RegExp): number => header.findIndex((h) => re.test(h));
  const nameCol = findCol(/\b(skill|name)\b/i);
  const srcCol = findCol(/\b(source|ref|repo)\b/i);
  const descCol = findCol(/\b(what|desc|about)/i);
  const starsCol = findCol(/\b(install|star|score)/i);
  if (nameCol === -1 || srcCol === -1) return [];

  const candidates: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 2; i < tableLines.length; i++) {
    const row = tableLines[i];
    if (row === undefined) continue;
    const cells = parseRow(row);
    const name = cleanCell(cells[nameCol] ?? '');
    const src = cleanCell(cells[srcCol] ?? '');
    if (name === '' || src === '') continue;
    // Compose installable ref. Repo-style sources (`owner/repo`) need
    // the `@skill` suffix for `npx skills add` to know which skill to
    // pull. Plain refs stand on their own.
    const ref = src.includes('/') && !src.includes('@') ? `${src}@${name}` : src;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const description = descCol >= 0 ? cleanCell(cells[descCol] ?? '') : '';
    const stars = starsCol >= 0 ? parseInstallsCount(cells[starsCol] ?? '') : null;
    candidates.push({ name, ref, description, stars });
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
