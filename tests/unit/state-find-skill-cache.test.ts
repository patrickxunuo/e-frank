import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetFindSkillCacheForTests,
  clearFindSkillCache,
  getFindSkillCache,
  hasFindSkillCache,
  saveFindSkillCache,
  type FindSkillCacheState,
} from '../../src/renderer/state/find-skill-cache';

/**
 * CACHE-001..005 — `find-skill-cache` module store.
 *
 * The cache is a singleton in-module store. The tests share the
 * module via vitest's import-graph caching, so each test cleans up
 * after itself via `__resetFindSkillCacheForTests`.
 */

afterEach(() => {
  __resetFindSkillCacheForTests();
});

const populated: FindSkillCacheState = {
  query: 'portfolio design',
  lines: [
    { id: 0, stream: 'stdout', text: '[{"name":"frontend-design","ref":"vercel-labs/skills@frontend-design"}]' },
  ],
  findError: null,
  nextLineId: 1,
};

describe('find-skill-cache', () => {
  it('CACHE-001: initial state is empty', () => {
    const s = getFindSkillCache();
    expect(s.query).toBe('');
    expect(s.lines).toEqual([]);
    expect(s.findError).toBeNull();
    expect(s.nextLineId).toBe(0);
  });

  it('CACHE-002: saveFindSkillCache round-trips data through getFindSkillCache', () => {
    saveFindSkillCache(populated);
    const s = getFindSkillCache();
    expect(s).toEqual(populated);
  });

  it('CACHE-003: clearFindSkillCache resets to the initial state', () => {
    saveFindSkillCache(populated);
    clearFindSkillCache();
    const s = getFindSkillCache();
    expect(s.query).toBe('');
    expect(s.lines).toEqual([]);
    expect(s.findError).toBeNull();
    expect(s.nextLineId).toBe(0);
  });

  it('CACHE-004: hasFindSkillCache reflects whether lines are populated', () => {
    expect(hasFindSkillCache()).toBe(false);
    saveFindSkillCache(populated);
    expect(hasFindSkillCache()).toBe(true);
    clearFindSkillCache();
    expect(hasFindSkillCache()).toBe(false);
  });

  it('CACHE-005: __resetFindSkillCacheForTests clears even from a populated state', () => {
    saveFindSkillCache(populated);
    expect(hasFindSkillCache()).toBe(true);
    __resetFindSkillCacheForTests();
    expect(hasFindSkillCache()).toBe(false);
    expect(getFindSkillCache().query).toBe('');
  });
});
