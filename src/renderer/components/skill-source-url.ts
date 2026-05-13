/**
 * Derive the public source URL for a skill ref.
 *
 * Used by the "View" button on suggested-skill cards in
 * `FindSkillDialog`. Returns `null` when the ref doesn't correspond
 * to a known web destination (e.g. bare registry name like
 * `find-skills`), in which case the View button is hidden.
 *
 * Rules:
 *   - `owner/repo@skill`  → `https://github.com/owner/repo`
 *   - `owner/repo`        → `https://github.com/owner/repo`
 *   - `find-skills`       → null  (registry-resolved bare name; no URL)
 *
 * Defensive: any ref we can't confidently route to a GitHub repo
 * returns null rather than guessing — the IPC handler also validates
 * the URL against an allow-list, but the cleaner UX is to omit the
 * button for refs we don't know how to link.
 */

const REPO_RE = /^([a-zA-Z0-9][\w.-]*)\/([\w.-]+)$/;
const FULL_RE = /^([a-zA-Z0-9][\w.-]*)\/([\w.-]+)@[\w.-]+$/;

export function getSkillSourceUrl(ref: string): string | null {
  const trimmed = ref.trim();
  if (trimmed === '') return null;
  const full = FULL_RE.exec(trimmed);
  if (full !== null) {
    return `https://github.com/${full[1]}/${full[2]}`;
  }
  const repo = REPO_RE.exec(trimmed);
  if (repo !== null) {
    return `https://github.com/${repo[1]}/${repo[2]}`;
  }
  return null;
}
