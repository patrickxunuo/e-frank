/**
 * Validate URLs accepted by the `shell:open-external` IPC channel.
 *
 * Defense-in-depth: a compromised renderer must NOT be able to ask
 * Electron to open arbitrary `javascript:` / `file://` / unknown-host
 * URLs via `shell.openExternal`. The "View" button on suggested-skill
 * cards in FindSkillDialog is the only legitimate caller; it derives
 * URLs from `getSkillSourceUrl(ref)` which only ever produces a
 * `https://github.com/...` URL.
 *
 * Rules:
 *   - Must parse via `new URL()` and produce a known absolute form.
 *   - Protocol must be `https:` or `http:` (http allowed for
 *     `localhost`-style dev refs in case we ever ship them; the
 *     hostname allow-list still gates production hosts).
 *   - Hostname must be in `ALLOWED_HOSTS` exactly (no subdomain
 *     fuzzing — `github.com` ≠ `evil-github.com`).
 */

export const ALLOWED_HOSTS: ReadonlyArray<string> = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'npmjs.com',
  'www.npmjs.com',
];

export type ValidateOpenExternalResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'INVALID_URL' | 'BAD_PROTOCOL' | 'FORBIDDEN_HOST' };

export function validateOpenExternalUrl(input: unknown): ValidateOpenExternalResult {
  if (typeof input !== 'string' || input === '') {
    return { ok: false, reason: 'INVALID_URL' };
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'BAD_PROTOCOL' };
  }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return { ok: false, reason: 'FORBIDDEN_HOST' };
  }
  // Re-emit the canonical form so callers don't pass through the raw
  // user input. This also normalises trailing whitespace or fragments.
  return { ok: true, url: parsed.toString() };
}
