/**
 * Installed-skill source tracker (#GH-93 polish).
 *
 * The `skills` CLI installs skills into `~/.claude/skills/<folder>/`
 * keyed only by skill name — once installed, there's no on-disk record
 * of which `owner/repo` the skill came from. That makes accurate
 * source-aware dedupe in the FindSkillDialog impossible (two unrelated
 * skills sharing a name would both look "installed").
 *
 * This module sidesteps the gap by maintaining a small JSON file
 * `<userData>/installed-skill-sources.json` mapping skill folder name →
 * source repo. The main process writes a new entry after every
 * successful install IPC, and the scanner reads the file when listing
 * skills so the renderer can dedupe by (skillId, source) tuple.
 *
 * Skills installed before this tracker existed have no entry — the
 * scanner surfaces them with `sourceRepo: null` and the dialog falls
 * back to name-only match for backward compat.
 *
 * Tiny enough to be inline-store rather than the full ConnectionStore
 * envelope pattern: schema-versioned wrapper + atomic tmp+rename write,
 * tolerant of missing/corrupt files.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

interface Envelope {
  /** Bump on incompatible shape changes. */
  schemaVersion: 1;
  /** Map of skill folder name → source repo (e.g. `owner/repo`). */
  sources: Record<string, string>;
}

const EMPTY_ENVELOPE: Envelope = { schemaVersion: 1, sources: {} };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse a raw envelope from disk. Returns the empty envelope on any
 *  shape mismatch — the file is a cache, not authoritative state, so
 *  silent recovery beats hard failure. */
function parseEnvelope(raw: unknown): Envelope {
  if (!isPlainObject(raw)) return EMPTY_ENVELOPE;
  if (raw['schemaVersion'] !== 1) return EMPTY_ENVELOPE;
  const sources = raw['sources'];
  if (!isPlainObject(sources)) return EMPTY_ENVELOPE;
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(sources)) {
    if (typeof value === 'string' && value.length > 0) {
      filtered[key] = value;
    }
  }
  return { schemaVersion: 1, sources: filtered };
}

/**
 * Read the source map from disk. Returns an empty map if the file
 * doesn't exist or fails to parse — never throws.
 */
export async function loadInstalledSkillSources(
  filePath: string,
): Promise<Record<string, string>> {
  try {
    const body = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(body) as unknown;
    return parseEnvelope(parsed).sources;
  } catch {
    // ENOENT / parse error / IO error → empty map. The file rebuilds
    // itself on the next successful install.
    return {};
  }
}

/**
 * Record (or overwrite) the source repo for a given installed skill.
 * Atomic via `.tmp-{uuid}` + rename so a crash mid-write can't leave a
 * truncated file. Silently swallows any error — the dialog's dedupe
 * falls back to name-only match if the marker write fails.
 */
export async function setInstalledSkillSource(
  filePath: string,
  skillId: string,
  source: string,
): Promise<void> {
  if (skillId === '' || source === '') return;
  try {
    const existing = await loadInstalledSkillSources(filePath);
    existing[skillId] = source;
    const envelope: Envelope = { schemaVersion: 1, sources: existing };
    const tmpPath = `${filePath}.tmp-${randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(envelope, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  } catch {
    // Best-effort. If we can't write the marker, the dialog falls back
    // to name-only dedupe — annoying but not broken.
  }
}
