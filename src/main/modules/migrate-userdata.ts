/**
 * One-shot userData migration (#GH-51).
 *
 * Renaming the Electron `productName` from `e-frank` to `Paperplane` makes
 * `app.getPath('userData')` resolve to a new directory:
 *
 *  - Windows : `%APPDATA%\Paperplane\`             (was `%APPDATA%\e-frank\`)
 *  - macOS   : `~/Library/Application Support/Paperplane/`
 *
 * Without a migration step, every existing user would lose their stored
 * projects, secrets, run history, and run logs on first launch of the
 * renamed build. This module copies the legacy tree into the new dir on
 * first boot after the rename, then leaves a marker file so the migration
 * is a no-op on every subsequent boot.
 *
 * Design constraints:
 *  - Idempotent. Safe to call on every boot.
 *  - Tolerant of partial failure. Per-file errors are recorded but never
 *    thrown — the app must still boot.
 *  - Never deletes the legacy dir. A separate cleanup ticket can prune it
 *    once the migration has been proven stable in production.
 *  - Pure Node, no Electron imports. Caller (main/index.ts) injects the
 *    resolved paths; tests inject temp dirs.
 */
import { promises as fsp, type Stats } from 'node:fs';
import { join, relative } from 'node:path';

export interface MigrateUserDataDeps {
  /** New userData dir (where Electron stores data given the new productName). */
  newUserDataDir: string;
  /**
   * Legacy `e-frank` userData dir, computed by the caller as
   * `path.join(app.getPath('appData'), 'e-frank')` — we accept it as input so
   * unit tests don't need to mock Electron.
   */
  legacyUserDataDir: string;
}

export type MigrationOutcome =
  | { kind: 'no-legacy' }
  | { kind: 'already-migrated' }
  | {
      kind: 'migrated';
      copied: number;
      skipped: number;
      errors: string[];
    }
  | { kind: 'failed'; error: string };

const MARKER_FILENAME = 'migrated-from-efrank.json';
const LOG_FILENAME = 'migration.log';

interface CountAccumulator {
  copied: number;
  skipped: number;
  errors: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(path: string): Promise<Stats | null> {
  try {
    return await fsp.stat(path);
  } catch {
    return null;
  }
}

/**
 * Recursively walk `src` and copy each entry into `dest`. Skips files that
 * already exist at the destination (resume-safe). Per-entry errors are
 * recorded in `acc.errors` instead of thrown.
 */
async function copyTree(
  src: string,
  dest: string,
  acc: CountAccumulator,
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: boolean }>;
  try {
    const dirents = await fsp.readdir(src, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch (error) {
    acc.errors.push(`readdir failed at ${src}: ${describeError(error)}`);
    return;
  }

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory) {
      try {
        await fsp.mkdir(destPath, { recursive: true });
      } catch (error) {
        acc.errors.push(
          `mkdir failed at ${destPath}: ${describeError(error)}`,
        );
        continue;
      }
      await copyTree(srcPath, destPath, acc);
      continue;
    }

    if (await exists(destPath)) {
      acc.skipped += 1;
      continue;
    }

    try {
      await fsp.copyFile(srcPath, destPath);
      acc.copied += 1;
    } catch (error) {
      acc.errors.push(`copyFile failed at ${srcPath}: ${describeError(error)}`);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function appendLog(
  dir: string,
  outcome: MigrationOutcome,
  legacyUserDataDir: string,
): Promise<void> {
  const ts = new Date().toISOString();
  const summary = JSON.stringify(outcome);
  const block =
    `=== ${ts} migrate-userdata\n` +
    `source: ${legacyUserDataDir}\n` +
    `outcome: ${summary}\n\n`;
  try {
    await fsp.appendFile(join(dir, LOG_FILENAME), block, 'utf8');
  } catch {
    // Logging is best-effort — never break boot because we couldn't append.
  }
}

async function writeMarker(
  dir: string,
  legacyUserDataDir: string,
  acc: CountAccumulator,
): Promise<void> {
  const payload = {
    migratedAt: new Date().toISOString(),
    source: legacyUserDataDir,
    counts: { copied: acc.copied, skipped: acc.skipped, errors: acc.errors.length },
    errors: acc.errors,
  };
  try {
    await fsp.writeFile(
      join(dir, MARKER_FILENAME),
      JSON.stringify(payload, null, 2) + '\n',
      'utf8',
    );
  } catch (error) {
    // If we can't write the marker the migration will re-run on the next
    // boot. That's preferable to crashing the app.
    acc.errors.push(`writeMarker failed: ${describeError(error)}`);
  }
}

export async function migrateUserData(
  deps: MigrateUserDataDeps,
): Promise<MigrationOutcome> {
  const { newUserDataDir, legacyUserDataDir } = deps;

  // Sanity guard: if the two paths resolve to the same directory we have
  // nothing to do (this happens when the rename hasn't taken effect, e.g.
  // dev runs without a packaged build).
  if (relative(legacyUserDataDir, newUserDataDir) === '') {
    return { kind: 'no-legacy' };
  }

  const legacyStat = await statSafe(legacyUserDataDir);
  if (legacyStat === null || !legacyStat.isDirectory()) {
    return { kind: 'no-legacy' };
  }

  try {
    await fsp.mkdir(newUserDataDir, { recursive: true });
  } catch (error) {
    return { kind: 'failed', error: describeError(error) };
  }

  if (await exists(join(newUserDataDir, MARKER_FILENAME))) {
    return { kind: 'already-migrated' };
  }

  const acc: CountAccumulator = { copied: 0, skipped: 0, errors: [] };
  await copyTree(legacyUserDataDir, newUserDataDir, acc);
  await writeMarker(newUserDataDir, legacyUserDataDir, acc);
  const outcome: MigrationOutcome = {
    kind: 'migrated',
    copied: acc.copied,
    skipped: acc.skipped,
    errors: acc.errors,
  };
  await appendLog(newUserDataDir, outcome, legacyUserDataDir);
  return outcome;
}
