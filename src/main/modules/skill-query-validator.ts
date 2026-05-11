/**
 * `isValidFindSkillsQuery` — shell-injection defense for the `query`
 * parameter passed to `claude /find-skills <query>` (GH-38).
 *
 * `NodeSpawner` defaults to `shell: true` so the query is concatenated
 * into a `cmd.exe /d /s /c "claude ... -p /find-skills <query>"` string
 * before the OS sees it. Without this guard a renderer-controlled
 * `query` containing `& calc.exe &` or backtick-substitution chains
 * would execute arbitrary commands.
 *
 * Whitelist-only: allow plain English search prose. Reject everything
 * cmd.exe / sh treats as a separator, substitution, or quote toggle.
 * Length-cap to keep argv bounded.
 */

const MAX_QUERY_LENGTH = 200;
const BANNED = /[`$<>|&;"'\\(){}[\]\r\n\t]/;

export function isValidFindSkillsQuery(q: string): boolean {
  if (typeof q !== 'string') return false;
  if (q.length === 0 || q.length > MAX_QUERY_LENGTH) return false;
  if (BANNED.test(q)) return false;
  return true;
}
