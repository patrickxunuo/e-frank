import { describe, it, expect } from 'vitest';
import { isValidFindSkillsQuery } from '../../src/main/modules/skill-query-validator';

/**
 * FIND-QUERY-001..010 — shell-injection defense for the `query` parameter
 * passed to `claude /find-skills <query>`. The validator is the only
 * thing standing between a renderer-controlled string and a `cmd.exe`
 * concatenation (NodeSpawner defaults to `shell: true`).
 *
 * Spec: allow letters / digits / spaces / common punctuation appropriate
 * for natural-English search; reject EVERY character cmd.exe / sh
 * treats as a separator, substitution, or quote toggle.
 */

describe('isValidFindSkillsQuery', () => {
  it('FIND-QUERY-001: accepts natural English search prose', () => {
    expect(isValidFindSkillsQuery('image cropping')).toBe(true);
    expect(isValidFindSkillsQuery('deploy to fly.io')).toBe(true);
    expect(isValidFindSkillsQuery('how do I add dark mode?')).toBe(true);
    expect(isValidFindSkillsQuery('a/b/c-d_e:f.g 1,2,3')).toBe(true);
  });

  it('FIND-QUERY-002: rejects empty string', () => {
    expect(isValidFindSkillsQuery('')).toBe(false);
  });

  it('FIND-QUERY-003: rejects double-quote (cmd.exe quote toggle)', () => {
    expect(isValidFindSkillsQuery('hi"& calc.exe & echo "')).toBe(false);
    expect(isValidFindSkillsQuery('say "hello"')).toBe(false);
  });

  it('FIND-QUERY-004: rejects single-quote (sh quote toggle)', () => {
    expect(isValidFindSkillsQuery("can't")).toBe(false);
  });

  it('FIND-QUERY-005: rejects backtick (shell command substitution)', () => {
    expect(isValidFindSkillsQuery('hi`evil`')).toBe(false);
  });

  it('FIND-QUERY-006: rejects ampersand / pipe / semicolon (command chaining)', () => {
    expect(isValidFindSkillsQuery('hi & calc.exe')).toBe(false);
    expect(isValidFindSkillsQuery('hi | wc -l')).toBe(false);
    expect(isValidFindSkillsQuery('hi; rm -rf')).toBe(false);
  });

  it('FIND-QUERY-007: rejects $ (variable substitution), <, > (redirects)', () => {
    expect(isValidFindSkillsQuery('hi $HOME')).toBe(false);
    expect(isValidFindSkillsQuery('hi > /tmp/x')).toBe(false);
    expect(isValidFindSkillsQuery('hi < input')).toBe(false);
  });

  it('FIND-QUERY-008: rejects backslash (cmd.exe escape) and parens/braces/brackets', () => {
    expect(isValidFindSkillsQuery('a\\b')).toBe(false);
    expect(isValidFindSkillsQuery('a(b)')).toBe(false);
    expect(isValidFindSkillsQuery('a{b}')).toBe(false);
    expect(isValidFindSkillsQuery('a[b]')).toBe(false);
  });

  it('FIND-QUERY-009: rejects newlines / tabs (multi-line injection)', () => {
    expect(isValidFindSkillsQuery('hi\n& calc.exe')).toBe(false);
    expect(isValidFindSkillsQuery('hi\t& calc.exe')).toBe(false);
    expect(isValidFindSkillsQuery('hi\r\n')).toBe(false);
  });

  it('FIND-QUERY-010: rejects queries longer than 200 chars', () => {
    expect(isValidFindSkillsQuery('x'.repeat(200))).toBe(true);
    expect(isValidFindSkillsQuery('x'.repeat(201))).toBe(false);
  });

  it('FIND-QUERY-011: rejects non-string inputs (defensive)', () => {
    expect(isValidFindSkillsQuery(123 as unknown as string)).toBe(false);
    expect(isValidFindSkillsQuery(null as unknown as string)).toBe(false);
    expect(isValidFindSkillsQuery(undefined as unknown as string)).toBe(false);
  });

  it('FIND-QUERY-012: rejects cmd.exe escape (^) and env-var expansion (%)', () => {
    // `%FOO%` expands env vars even inside `"..."` on cmd.exe — leaks
    // host info into the claude argv visible via `tasklist`/`ps`.
    expect(isValidFindSkillsQuery('hi %USERNAME%')).toBe(false);
    expect(isValidFindSkillsQuery('100%')).toBe(false);
    // `^` is cmd.exe's escape — irrelevant inside `"..."` today, but cheap
    // defense-in-depth against future code paths.
    expect(isValidFindSkillsQuery('a^b')).toBe(false);
  });
});
