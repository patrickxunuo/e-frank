/**
 * SkillsScanner — enumerate installed Claude Code skills.
 *
 * Claude resolves slash-command skills from `${cwd}/.claude/skills/` first,
 * then falls back to `~/.claude/skills/`. This scanner mirrors that order
 * when collecting skills for the renderer: project skills win when an id
 * collides with a user skill. See `skill-installer.ts` for the same
 * resolution-order rationale.
 *
 * Per-skill record:
 *   - id          : folder slug (e.g. `ef-auto-feature`)
 *   - name        : `name:` from SKILL.md frontmatter, falls back to id
 *   - description : `description:` from SKILL.md frontmatter (may be empty)
 *   - source      : 'user' | 'project'
 *   - dirPath     : absolute path to the skill's directory
 *   - skillMdPath : absolute path to SKILL.md
 *
 * The frontmatter parser handles a leading `---\n...---\n` block with
 * `key: value` lines. Quoted values (`'…'` / `"…"`) are unwrapped.
 * Anything fancier (YAML lists, multi-line scalars) is not supported —
 * SKILL.md frontmatter in practice is flat and we keep this dep-free.
 *
 * Errors are swallowed at the granularity of one skill: a malformed
 * SKILL.md surfaces with an empty name/description rather than aborting
 * the whole scan. A missing skills root (no `~/.claude/skills/` yet)
 * simply returns no entries from that source.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SkillSource, SkillSummary } from '../../shared/ipc.js';

/** Test seam. The scanner does only directory listings + file reads. */
export interface SkillsScannerFs {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

function defaultFs(): SkillsScannerFs {
  return {
    readdir: (path) => fs.readdir(path),
    readFile: (path, encoding) => fs.readFile(path, encoding),
    stat: (path) => fs.stat(path),
  };
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Parse a SKILL.md frontmatter block. Returns whatever keys were found;
 * callers fall back to defaults for missing fields. Tolerates files
 * without frontmatter (returns `{}`).
 */
export function parseSkillFrontmatter(source: string): Record<string, string> {
  // Normalize CRLF — SKILL.md authored on Windows can leak \r into values.
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  const block = text.slice(4, end);
  const out: Record<string, string> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') out[key] = value;
  }
  return out;
}

export interface ScanSkillsOptions {
  /** Override `~/.claude/skills`. */
  userRoot?: string;
  /**
   * Project-local skills root (typically `<cwd>/.claude/skills`).
   * Omit to disable project-source scanning.
   */
  projectRoot?: string;
  fs?: SkillsScannerFs;
}

async function scanRoot(
  root: string,
  source: SkillSource,
  fsImpl: SkillsScannerFs,
): Promise<SkillSummary[]> {
  let entries: string[];
  try {
    entries = await fsImpl.readdir(root);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const result: SkillSummary[] = [];
  for (const id of entries) {
    if (id.startsWith('.')) continue;
    const dirPath = join(root, id);
    let isDir = false;
    try {
      const s = await fsImpl.stat(dirPath);
      isDir = s.isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillMdPath = join(dirPath, 'SKILL.md');
    let body: string;
    try {
      body = await fsImpl.readFile(skillMdPath, 'utf8');
    } catch (err) {
      // No SKILL.md → not a skill directory. Skip.
      if (isENOENT(err)) continue;
      // Some other read failure → still surface the folder with empty
      // fields rather than dropping it; the user may want to "Open" it
      // and inspect.
      result.push({
        id,
        name: id,
        description: '',
        source,
        dirPath,
        skillMdPath,
      });
      continue;
    }
    const fm = parseSkillFrontmatter(body);
    result.push({
      id,
      name: fm.name ?? id,
      description: fm.description ?? '',
      source,
      dirPath,
      skillMdPath,
    });
  }
  return result;
}

/**
 * Scan installed skills across user-level and (optional) project-level
 * roots. Project entries override user entries with the same id.
 * Results are sorted by display name (case-insensitive) within each
 * dedupe pass so the renderer doesn't need its own ordering.
 */
export async function scanInstalledSkills(
  options: ScanSkillsOptions = {},
): Promise<SkillSummary[]> {
  const fsImpl = options.fs ?? defaultFs();
  const userRoot = options.userRoot ?? join(homedir(), '.claude', 'skills');
  const projectRoot = options.projectRoot;

  const userSkills = await scanRoot(userRoot, 'user', fsImpl);
  const projectSkills =
    projectRoot === undefined ? [] : await scanRoot(projectRoot, 'project', fsImpl);

  const merged = new Map<string, SkillSummary>();
  for (const s of userSkills) merged.set(s.id, s);
  for (const s of projectSkills) merged.set(s.id, s); // overrides

  return Array.from(merged.values()).sort((a, b) =>
    a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()),
  );
}
