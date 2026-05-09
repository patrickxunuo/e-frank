import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateUserData } from '../../src/main/modules/migrate-userdata';

/**
 * MIGRATE-USERDATA — one-shot legacy `e-frank` → `Paperplane` migration
 * (#GH-51). Tests use real temp dirs because the function only reaches into
 * `node:fs/promises` and `node:path` — no Electron mocks needed.
 */

let workspace: string;
let legacy: string;
let next: string;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readFile(p: string): Promise<string> {
  return fsp.readFile(p, 'utf8');
}

beforeEach(async () => {
  workspace = await fsp.mkdtemp(join(tmpdir(), 'migrate-userdata-'));
  legacy = join(workspace, 'e-frank');
  next = join(workspace, 'Paperplane');
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
});

describe('migrateUserData', () => {
  it('MIGRATE-001: returns no-legacy when the legacy dir does not exist', async () => {
    const outcome = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: legacy,
    });
    expect(outcome.kind).toBe('no-legacy');
    // We must NOT have created the new dir for a no-legacy case.
    expect(await fileExists(next)).toBe(false);
  });

  it('MIGRATE-002: copies a legacy tree into a fresh new dir', async () => {
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(join(legacy, 'projects.json'), '[{"id":"p1"}]', 'utf8');
    await fsp.mkdir(join(legacy, 'runs', 'run-1'), { recursive: true });
    await fsp.writeFile(
      join(legacy, 'runs', 'run-1', 'log.json'),
      'log-contents',
      'utf8',
    );
    await fsp.writeFile(
      join(legacy, 'secrets.json'),
      'encrypted-blob',
      'utf8',
    );

    const outcome = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: legacy,
    });

    expect(outcome.kind).toBe('migrated');
    if (outcome.kind === 'migrated') {
      expect(outcome.copied).toBe(3);
      expect(outcome.skipped).toBe(0);
      expect(outcome.errors).toEqual([]);
    }
    expect(await readFile(join(next, 'projects.json'))).toBe('[{"id":"p1"}]');
    expect(await readFile(join(next, 'runs', 'run-1', 'log.json'))).toBe(
      'log-contents',
    );
    expect(await readFile(join(next, 'secrets.json'))).toBe('encrypted-blob');
    expect(await fileExists(join(next, 'migrated-from-efrank.json'))).toBe(true);
  });

  it('MIGRATE-003: is idempotent — second call short-circuits via marker', async () => {
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(join(legacy, 'projects.json'), 'first', 'utf8');

    await migrateUserData({ newUserDataDir: next, legacyUserDataDir: legacy });

    // Modify the legacy file AFTER first migration; a second run must NOT
    // overwrite the new dir's copy.
    await fsp.writeFile(join(legacy, 'projects.json'), 'second', 'utf8');
    const second = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: legacy,
    });

    expect(second.kind).toBe('already-migrated');
    expect(await readFile(join(next, 'projects.json'))).toBe('first');
  });

  it('MIGRATE-004: skips files that already exist at the destination', async () => {
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.mkdir(next, { recursive: true });
    await fsp.writeFile(join(legacy, 'a.json'), 'legacy-a', 'utf8');
    await fsp.writeFile(join(legacy, 'b.json'), 'legacy-b', 'utf8');
    // Pre-existing file in `next` (e.g. partial prior migration).
    await fsp.writeFile(join(next, 'a.json'), 'pre-existing', 'utf8');

    const outcome = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: legacy,
    });

    expect(outcome.kind).toBe('migrated');
    if (outcome.kind === 'migrated') {
      expect(outcome.copied).toBe(1);
      expect(outcome.skipped).toBe(1);
    }
    // `a.json` kept the existing content.
    expect(await readFile(join(next, 'a.json'))).toBe('pre-existing');
    expect(await readFile(join(next, 'b.json'))).toBe('legacy-b');
  });

  it('MIGRATE-005: never deletes the legacy directory after a successful copy', async () => {
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(join(legacy, 'projects.json'), 'data', 'utf8');

    await migrateUserData({ newUserDataDir: next, legacyUserDataDir: legacy });

    expect(await fileExists(legacy)).toBe(true);
    expect(await readFile(join(legacy, 'projects.json'))).toBe('data');
  });

  it('MIGRATE-006: appends a migration.log block on each migrated run', async () => {
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(join(legacy, 'a.json'), 'first', 'utf8');

    const first = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: legacy,
    });
    expect(first.kind).toBe('migrated');

    const log1 = await readFile(join(next, 'migration.log'));
    expect(log1).toContain('migrate-userdata');
    expect(log1).toContain('"kind":"migrated"');

    // The second call short-circuits via marker, so the log isn't appended
    // from migrateUserData itself — we delete the marker to simulate a re-run
    // and confirm the log GROWS rather than being overwritten.
    await fsp.rm(join(next, 'migrated-from-efrank.json'));
    await fsp.writeFile(join(legacy, 'b.json'), 'second', 'utf8');
    const second = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: legacy,
    });
    expect(second.kind).toBe('migrated');

    const log2 = await readFile(join(next, 'migration.log'));
    expect(log2.length).toBeGreaterThan(log1.length);
    // Two block headers present. Anchor on `=== ` so substring matches
    // inside the temp dir path (e.g. mkdtemp's `migrate-userdata-` prefix)
    // don't inflate the count.
    const matches = log2.match(/^=== /gm) ?? [];
    expect(matches.length).toBe(2);
  });

  it('MIGRATE-007: returns no-legacy when the legacy and new paths are identical', async () => {
    // Same path is the dev-mode shape (package.json `name` stays `e-frank`,
    // so userData resolves to `%APPDATA%\e-frank\`, equal to the legacy dir).
    await fsp.mkdir(next, { recursive: true });
    await fsp.writeFile(join(next, 'projects.json'), 'dev-mode', 'utf8');

    const outcome = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: next,
    });
    expect(outcome.kind).toBe('no-legacy');
    // The marker must NOT have been written — that would prevent a real
    // migration from running later when the user upgrades to a packaged
    // build with the renamed productName.
    expect(await fileExists(join(next, 'migrated-from-efrank.json'))).toBe(false);
  });

  it('MIGRATE-008: returns failed when the new dir cannot be created', async () => {
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(join(legacy, 'a.json'), 'data', 'utf8');

    // Block mkdir by putting a regular file at the new-dir path. mkdir
    // recursive should fail because a non-directory occupies the slot.
    await fsp.writeFile(next, 'not-a-directory', 'utf8');

    const outcome = await migrateUserData({
      newUserDataDir: next,
      legacyUserDataDir: legacy,
    });
    expect(outcome.kind).toBe('failed');
  });

  it('MIGRATE-009: marker payload records source, counts, and errors', async () => {
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(join(legacy, 'projects.json'), 'p', 'utf8');
    await fsp.writeFile(join(legacy, 'connections.json'), 'c', 'utf8');

    await migrateUserData({ newUserDataDir: next, legacyUserDataDir: legacy });
    const raw = await readFile(join(next, 'migrated-from-efrank.json'));
    const parsed = JSON.parse(raw) as {
      migratedAt: string;
      source: string;
      counts: { copied: number; skipped: number; errors: number };
      errors: string[];
    };

    expect(parsed.source).toBe(legacy);
    expect(parsed.counts.copied).toBe(2);
    expect(parsed.counts.skipped).toBe(0);
    expect(parsed.counts.errors).toBe(0);
    expect(parsed.errors).toEqual([]);
    expect(parsed.migratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
