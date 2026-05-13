import { describe, expect, it } from 'vitest';
import { getSkillSourceUrl } from '../../src/renderer/components/skill-source-url';

/**
 * SKILL-URL — derive a public GitHub URL from a skill install ref.
 * Drives the "View" button on suggested-skill cards in
 * FindSkillDialog. Returns null when the ref doesn't map to a known
 * web source — in which case the button is hidden, not disabled.
 */
describe('getSkillSourceUrl', () => {
  it('SKILL-URL-001: composes URL from `owner/repo@skill` form', () => {
    expect(getSkillSourceUrl('vercel-labs/skills@frontend-design')).toBe(
      'https://github.com/vercel-labs/skills',
    );
  });

  it('SKILL-URL-002: composes URL from `owner/repo` form', () => {
    expect(getSkillSourceUrl('getsentry/skills')).toBe('https://github.com/getsentry/skills');
  });

  it('SKILL-URL-003: returns null for bare registry name', () => {
    expect(getSkillSourceUrl('find-skills')).toBeNull();
    expect(getSkillSourceUrl('ef-feature')).toBeNull();
  });

  it('SKILL-URL-004: returns null for empty / whitespace', () => {
    expect(getSkillSourceUrl('')).toBeNull();
    expect(getSkillSourceUrl('   ')).toBeNull();
  });

  it('SKILL-URL-005: trims surrounding whitespace before parsing', () => {
    expect(getSkillSourceUrl('  owner/repo  ')).toBe('https://github.com/owner/repo');
    expect(getSkillSourceUrl('\towner/repo@skill\n')).toBe('https://github.com/owner/repo');
  });

  it('SKILL-URL-006: returns null for malformed refs', () => {
    // Multi-slash paths aren't a single `owner/repo` and we don't
    // want to guess. Same for refs with whitespace inside.
    expect(getSkillSourceUrl('a/b/c')).toBeNull();
    expect(getSkillSourceUrl('owner /repo')).toBeNull();
    expect(getSkillSourceUrl('owner/repo@')).toBeNull();
  });
});
