/**
 * `FindSkillDialog` result cache — module-level state that survives
 * dialog close/open cycles within a single app session.
 *
 * Memory-only. No localStorage, no userData persistence: when the app
 * closes the cache is dropped naturally. That matches the user's
 * intent ("keep the suggested skills until next search starts or app
 * gets closed") and avoids the question of whether stale results from
 * weeks ago should hydrate the dialog on next launch.
 *
 * Singleton: there's only one FindSkillDialog instance in the app
 * (mounted by Skills.tsx). If a second caller ever mounts the dialog,
 * they'll share state — acceptable trade-off for the current surface.
 *
 * Why not `useSyncExternalStore` (cf. `state/notifications.ts`)? The
 * dialog hydrates on the `open` transition synchronously via
 * `getFindSkillCache()` inside a useEffect — there's no need for a
 * reactive subscription because only the dialog reads, only the
 * dialog (or the Clear button it owns) writes, and they're never
 * mounted concurrently.
 */

/**
 * One line of streamed `claude` output. Lives in the cache module so
 * the dialog and the cache share the same line shape — re-exported by
 * the dialog for in-component use.
 */
export interface OutputLine {
  id: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface FindSkillCacheState {
  /** Query string that produced the cached lines. Empty when no find has completed yet. */
  query: string;
  /** Raw streamed lines from the last completed find. */
  lines: ReadonlyArray<OutputLine>;
  /** Banner-level find error (timeout / spawn-error / non-zero exit). */
  findError: string | null;
  /**
   * Counter used to issue next `OutputLine.id` after rehydration. We
   * persist it so any post-hydration line additions (rare — the find
   * is done by the time we cache) keep React keys unique against the
   * already-restored lines.
   */
  nextLineId: number;
}

const EMPTY: FindSkillCacheState = {
  query: '',
  lines: [],
  findError: null,
  nextLineId: 0,
};

let state: FindSkillCacheState = EMPTY;

export function getFindSkillCache(): FindSkillCacheState {
  return state;
}

export function saveFindSkillCache(next: FindSkillCacheState): void {
  state = next;
}

export function clearFindSkillCache(): void {
  state = EMPTY;
}

/** True when there's at least one cached line — drives Clear button enablement. */
export function hasFindSkillCache(): boolean {
  return state.lines.length > 0;
}

/** Test-only reset. Symmetric with `__resetNotificationsForTests`. */
export function __resetFindSkillCacheForTests(): void {
  state = EMPTY;
}
