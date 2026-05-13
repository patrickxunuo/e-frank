import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS,
  validateOpenExternalUrl,
} from '../../src/main/modules/shell-external-validator';

/**
 * EXT-URL — defense-in-depth for `shell:open-external`. A compromised
 * renderer must not be able to ask Electron to open arbitrary protocols
 * (`javascript:`, `file://`) or unknown hosts. Only the renderer
 * View-source button is a legitimate caller, and it always derives
 * URLs via `getSkillSourceUrl` (which only yields github.com).
 */
describe('validateOpenExternalUrl', () => {
  it('EXT-URL-001: accepts https github URL', () => {
    const r = validateOpenExternalUrl('https://github.com/getsentry/skills');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://github.com/getsentry/skills');
    }
  });

  it('EXT-URL-002: accepts each allow-listed host', () => {
    for (const host of ALLOWED_HOSTS) {
      const r = validateOpenExternalUrl(`https://${host}/owner/repo`);
      expect(r.ok).toBe(true);
    }
  });

  it('EXT-URL-003: rejects `javascript:` scheme', () => {
    const r = validateOpenExternalUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('BAD_PROTOCOL');
    }
  });

  it('EXT-URL-004: rejects `file://` scheme', () => {
    const r = validateOpenExternalUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('BAD_PROTOCOL');
    }
  });

  it('EXT-URL-005: rejects unparseable input', () => {
    expect(validateOpenExternalUrl('not a url').ok).toBe(false);
    expect(validateOpenExternalUrl('').ok).toBe(false);
    expect(validateOpenExternalUrl(null).ok).toBe(false);
    expect(validateOpenExternalUrl(undefined).ok).toBe(false);
    expect(validateOpenExternalUrl(123).ok).toBe(false);
  });

  it('EXT-URL-006: rejects look-alike hosts (no subdomain fuzzing)', () => {
    // `evil-github.com` and `github.com.evil.com` are NOT github.com.
    const looks = [
      'https://evil-github.com/owner/repo',
      'https://github.com.evil.com/owner/repo',
      'https://nope.github.com/owner/repo',
    ];
    for (const u of looks) {
      const r = validateOpenExternalUrl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('FORBIDDEN_HOST');
      }
    }
  });

  it('EXT-URL-007: rejects http:// for production hosts (still parseable but blocked by host check NOT protocol — http is accepted)', () => {
    // Note: http IS an allowed protocol (for future localhost-style
    // dev refs). But the host check still applies — and there's no
    // localhost in the allow-list, so http://localhost is rejected.
    const r = validateOpenExternalUrl('http://localhost:8080/');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('FORBIDDEN_HOST');
    }
  });
});
