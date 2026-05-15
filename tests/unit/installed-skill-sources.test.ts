import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadInstalledSkillSources,
  setInstalledSkillSource,
} from '../../src/main/modules/installed-skill-sources';

/**
 * SKILL-SOURCE-001..006 — `installed-skill-sources` JSON store (#GH-93 polish).
 *
 * Lightweight read/write helpers for the file the FindSkillDialog dedupe
 * relies on. Tests use a real tmpdir so the atomic .tmp+rename path runs
 * against a real filesystem.
 */

describe('installed-skill-sources', () => {
  let dir = '';
  let filePath = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gh93-sources-'));
    filePath = join(dir, 'installed-skill-sources.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('SKILL-SOURCE-001: load returns empty map when file does not exist', async () => {
    const map = await loadInstalledSkillSources(filePath);
    expect(map).toEqual({});
  });

  it('SKILL-SOURCE-002: load returns empty map for malformed JSON', async () => {
    await writeFile(filePath, 'this is not json{{', 'utf8');
    const map = await loadInstalledSkillSources(filePath);
    expect(map).toEqual({});
  });

  it('SKILL-SOURCE-003: load returns empty map for wrong schemaVersion', async () => {
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 999, sources: { foo: 'bar/baz' } }),
      'utf8',
    );
    const map = await loadInstalledSkillSources(filePath);
    expect(map).toEqual({});
  });

  it('SKILL-SOURCE-004: set creates the file with the entry; load round-trips', async () => {
    await setInstalledSkillSource(filePath, 'frontend-design', 'vercel-labs/agent-skills');
    const map = await loadInstalledSkillSources(filePath);
    expect(map).toEqual({ 'frontend-design': 'vercel-labs/agent-skills' });
    // Verify the on-disk shape is the schema envelope, not bare entries.
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw).toEqual({
      schemaVersion: 1,
      sources: { 'frontend-design': 'vercel-labs/agent-skills' },
    });
  });

  it('SKILL-SOURCE-005: set is incremental — existing entries are preserved across writes', async () => {
    await setInstalledSkillSource(filePath, 'first', 'a/b');
    await setInstalledSkillSource(filePath, 'second', 'c/d');
    const map = await loadInstalledSkillSources(filePath);
    expect(map).toEqual({ first: 'a/b', second: 'c/d' });
  });

  it('SKILL-SOURCE-006: set overwrites a prior entry for the same skillId (re-install from different source)', async () => {
    await setInstalledSkillSource(filePath, 'frontend-design', 'old-author/old-repo');
    await setInstalledSkillSource(filePath, 'frontend-design', 'new-author/new-repo');
    const map = await loadInstalledSkillSources(filePath);
    expect(map).toEqual({ 'frontend-design': 'new-author/new-repo' });
  });

  it('SKILL-SOURCE-007: set with empty skillId or empty source is a no-op', async () => {
    await setInstalledSkillSource(filePath, '', 'a/b');
    await setInstalledSkillSource(filePath, 'foo', '');
    const map = await loadInstalledSkillSources(filePath);
    expect(map).toEqual({});
  });
});
