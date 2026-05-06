import { describe, it, expect } from 'vitest';
import {
  validateConnection,
  validateConnectionInput,
  validateConnectionUpdate,
} from '../../src/shared/schema/connection';

/**
 * CONN-SCH-001..009 — Connection schema validators.
 *
 * Mirrors the structure of project-instance.test patterns:
 *  - validator collects ALL errors (not first-error-and-stop)
 *  - codes are stable identifiers (REQUIRED, NOT_STRING, etc.)
 *  - `INVALID_HOST` is the new code introduced for this issue
 *
 * The validators may not all be present yet (Agent B is implementing in
 * parallel) — these imports fail until that PR lands. The failure mode is
 * a module-import error at the top of this file.
 */

interface CollectedErrors {
  paths: string[];
  codes: string[];
}

function collect(result: { ok: boolean; errors?: Array<{ path: string; code: string }> }): CollectedErrors {
  const errors = result.errors ?? [];
  return {
    paths: errors.map((e) => e.path),
    codes: errors.map((e) => e.code),
  };
}

const VALID_GH_CONNECTION = {
  id: '11111111-2222-4333-8444-555555555555',
  provider: 'github',
  label: 'Personal',
  host: 'https://api.github.com',
  authMethod: 'pat',
  secretRef: 'connection:11111111-2222-4333-8444-555555555555:token',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe('connection schema — CONN-SCH', () => {
  // -----------------------------------------------------------------
  // CONN-SCH-001 — non-object input rejected
  // -----------------------------------------------------------------
  describe('CONN-SCH-001 non-object input', () => {
    it('CONN-SCH-001: null input → ok:false with NOT_OBJECT', () => {
      const res = validateConnection(null);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.some((e) => e.code === 'NOT_OBJECT')).toBe(true);
    });

    it('CONN-SCH-001: array input → ok:false', () => {
      const res = validateConnection([]);
      expect(res.ok).toBe(false);
    });

    it('CONN-SCH-001: primitive (string) input → ok:false', () => {
      const res = validateConnection('connection');
      expect(res.ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-002 — required fields
  // -----------------------------------------------------------------
  describe('CONN-SCH-002 required fields', () => {
    it('CONN-SCH-002: empty object reports REQUIRED for each contractual field', () => {
      const res = validateConnection({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const c = collect(res);
      // Per spec: id, provider, label, host, authMethod, secretRef,
      // createdAt, updatedAt — eight required fields total.
      const requiredPaths = [
        'id',
        'provider',
        'label',
        'host',
        'authMethod',
        'secretRef',
        'createdAt',
        'updatedAt',
      ];
      for (const p of requiredPaths) {
        expect(c.paths).toContain(p);
      }
      // Every reported error for those paths must be REQUIRED (or at least
      // any of the structural codes that imply required-and-missing).
      const requiredCount = c.codes.filter((code) => code === 'REQUIRED').length;
      expect(requiredCount).toBeGreaterThanOrEqual(requiredPaths.length);
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-003 — invalid provider
  // -----------------------------------------------------------------
  describe('CONN-SCH-003 invalid provider', () => {
    it('CONN-SCH-003: provider="gitlab" → INVALID_ENUM on path "provider"', () => {
      const res = validateConnection({ ...VALID_GH_CONNECTION, provider: 'gitlab' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const providerErr = res.errors.find((e) => e.path === 'provider');
      expect(providerErr).toBeDefined();
      expect(providerErr?.code).toBe('INVALID_ENUM');
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-004 — invalid authMethod
  // -----------------------------------------------------------------
  describe('CONN-SCH-004 invalid authMethod', () => {
    it('CONN-SCH-004: authMethod="oauth" → INVALID_ENUM on path "authMethod"', () => {
      const res = validateConnection({ ...VALID_GH_CONNECTION, authMethod: 'oauth' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'authMethod');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_ENUM');
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-005 — host missing scheme → INVALID_HOST
  // -----------------------------------------------------------------
  describe('CONN-SCH-005 host missing scheme', () => {
    it('CONN-SCH-005: host="example.com" → INVALID_HOST', () => {
      const res = validateConnection({ ...VALID_GH_CONNECTION, host: 'example.com' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'host');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_HOST');
    });

    it('CONN-SCH-005: host="ftp://x" → INVALID_HOST', () => {
      const res = validateConnection({ ...VALID_GH_CONNECTION, host: 'ftp://x' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'host');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_HOST');
    });

    it('CONN-SCH-005: host="https://api.github.com" → no host error', () => {
      const res = validateConnection(VALID_GH_CONNECTION);
      expect(res.ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-006 — createdAt/updatedAt must be finite numbers
  // -----------------------------------------------------------------
  describe('CONN-SCH-006 timestamps', () => {
    it('CONN-SCH-006: createdAt = NaN → NOT_NUMBER', () => {
      const res = validateConnection({ ...VALID_GH_CONNECTION, createdAt: Number.NaN });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'createdAt');
      expect(err).toBeDefined();
      expect(err?.code).toBe('NOT_NUMBER');
    });

    it('CONN-SCH-006: updatedAt = "1700000000000" (string) → NOT_NUMBER', () => {
      const res = validateConnection({
        ...VALID_GH_CONNECTION,
        updatedAt: '1700000000000',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'updatedAt');
      expect(err).toBeDefined();
      expect(err?.code).toBe('NOT_NUMBER');
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-007 — validateConnectionInput rejects `id` field
  // -----------------------------------------------------------------
  describe('CONN-SCH-007 input rejects id', () => {
    it('CONN-SCH-007: input with id present → INVALID_ID', () => {
      const res = validateConnectionInput({
        id: 'should-not-be-here',
        provider: 'github',
        label: 'Personal',
        host: 'https://api.github.com',
        authMethod: 'pat',
        plaintextToken: 'ghp_secrettoken',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'id');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_ID');
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-008 — input requires non-empty plaintextToken
  // -----------------------------------------------------------------
  describe('CONN-SCH-008 plaintextToken non-empty', () => {
    it('CONN-SCH-008: plaintextToken = "" → EMPTY', () => {
      const res = validateConnectionInput({
        provider: 'github',
        label: 'Personal',
        host: 'https://api.github.com',
        authMethod: 'pat',
        plaintextToken: '',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'plaintextToken');
      expect(err).toBeDefined();
      expect(err?.code).toBe('EMPTY');
    });

    it('CONN-SCH-008: plaintextToken = "   " (whitespace) → EMPTY', () => {
      const res = validateConnectionInput({
        provider: 'github',
        label: 'Personal',
        host: 'https://api.github.com',
        authMethod: 'pat',
        plaintextToken: '   ',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'plaintextToken');
      expect(err).toBeDefined();
      expect(err?.code).toBe('EMPTY');
    });

    it('CONN-SCH-008: plaintextToken missing entirely → REQUIRED', () => {
      const res = validateConnectionInput({
        provider: 'github',
        label: 'Personal',
        host: 'https://api.github.com',
        authMethod: 'pat',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'plaintextToken');
      expect(err).toBeDefined();
      expect(err?.code).toBe('REQUIRED');
    });
  });

  // -----------------------------------------------------------------
  // CONN-SCH-009 — Jira api-token requires email
  // -----------------------------------------------------------------
  describe('CONN-SCH-009 Jira api-token requires email', () => {
    it('CONN-SCH-009: provider=jira authMethod=api-token, missing email → REQUIRED on email', () => {
      const res = validateConnectionInput({
        provider: 'jira',
        label: 'emonster',
        host: 'https://emonster.atlassian.net',
        authMethod: 'api-token',
        plaintextToken: 'jira_secret_token',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'email');
      expect(err).toBeDefined();
      expect(err?.code).toBe('REQUIRED');
    });

    it('CONN-SCH-009: provider=jira authMethod=api-token, email="" → EMPTY', () => {
      const res = validateConnectionInput({
        provider: 'jira',
        label: 'emonster',
        host: 'https://emonster.atlassian.net',
        authMethod: 'api-token',
        plaintextToken: 'jira_secret_token',
        email: '',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'email');
      expect(err).toBeDefined();
      expect(['REQUIRED', 'EMPTY']).toContain(err?.code);
    });

    it('CONN-SCH-009: provider=jira with email present → ok:true', () => {
      const res = validateConnectionInput({
        provider: 'jira',
        label: 'emonster',
        host: 'https://emonster.atlassian.net',
        authMethod: 'api-token',
        plaintextToken: 'jira_secret_token',
        email: 'gazhang@emonster.tech',
      });
      expect(res.ok).toBe(true);
    });

    it('CONN-SCH-009: provider=github does NOT require email', () => {
      const res = validateConnectionInput({
        provider: 'github',
        label: 'Personal',
        host: 'https://api.github.com',
        authMethod: 'pat',
        plaintextToken: 'ghp_secrettoken',
      });
      expect(res.ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------
  // validateConnectionUpdate — sanity (kept lightweight; spec only
  // requires the function be importable + accept partial updates).
  // -----------------------------------------------------------------
  describe('validateConnectionUpdate (sanity)', () => {
    it('accepts an empty update object as ok', () => {
      const res = validateConnectionUpdate({});
      expect(res.ok).toBe(true);
    });

    it('rejects a non-object update', () => {
      const res = validateConnectionUpdate(null);
      expect(res.ok).toBe(false);
    });

    it('rejects empty plaintextToken when provided', () => {
      const res = validateConnectionUpdate({ plaintextToken: '' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const err = res.errors.find((e) => e.path === 'plaintextToken');
      expect(err).toBeDefined();
      expect(err?.code).toBe('EMPTY');
    });
  });
});
