/**
 * Connection schema + hand-rolled per-field validator.
 *
 * Mirrors the patterns of `project-instance.ts`:
 *  - validator collects ALL field errors before returning (not first-error-
 *    and-stop) so the form can surface every problem inline
 *  - codes are stable machine-readable identifiers; messages are safe to
 *    display in UI
 *  - module is renderer-safe — no Node-only imports
 *
 * Adds one new code beyond the project-instance vocabulary: `INVALID_HOST`
 * (host must start with `http://` or `https://`).
 */

// -- Const enums -------------------------------------------------------------

export const PROVIDERS = ['github', 'bitbucket', 'jira'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const AUTH_METHODS = ['pat', 'app-password', 'api-token'] as const;
/**
 * pat            — GitHub Personal Access Token
 * app-password   — Bitbucket App Password (placeholder; not implemented yet)
 * api-token      — Atlassian/Jira API token (Basic email:token)
 *
 * OAuth methods (oauth-device, oauth-3lo) arrive in #26 / #27 and extend
 * this enum.
 */
export type AuthMethod = (typeof AUTH_METHODS)[number];

// -- Domain types ------------------------------------------------------------

/** Provider-specific identity captured at last successful test (for display). */
export type ConnectionIdentity =
  | { kind: 'github'; login: string; name?: string; scopes?: string[] }
  | { kind: 'jira'; accountId: string; displayName: string; emailAddress?: string }
  | { kind: 'bitbucket'; username: string; displayName?: string };

export interface Connection {
  /** UUID v4 — assigned by the store. */
  id: string;
  provider: Provider;
  /** User-facing label, e.g. "Personal", "Acme Corp". Unique within provider. */
  label: string;
  /** Base URL for API calls (no trailing slash).
   *  GitHub: 'https://api.github.com' or 'https://ghes.example.com/api/v3'.
   *  Jira:   'https://acme.atlassian.net'. */
  host: string;
  authMethod: AuthMethod;
  /** SecretsManager ref where the token's plaintext is stored. Pattern: 'connection:{id}:token'. */
  secretRef: string;
  /** Optional — present after first successful Test Connection. */
  accountIdentity?: ConnectionIdentity;
  /** Epoch ms of last successful test, or `undefined` if never verified. */
  lastVerifiedAt?: number;
  /** Epoch ms — set on create. */
  createdAt: number;
  /** Epoch ms — bumped on every update. */
  updatedAt: number;
}

/** Input shape for create — id, secretRef, accountIdentity, timestamps assigned by the store. */
export interface ConnectionInput {
  provider: Provider;
  label: string;
  host: string;
  authMethod: AuthMethod;
  /** Required at create — the plaintext is set in SecretsManager and the ref derived. Never persisted as plaintext. */
  plaintextToken: string;
  /** For Jira `api-token` only: the email used in Basic auth. */
  email?: string;
}

export interface ConnectionUpdate {
  label?: string;
  host?: string;
  /** Provided only when the user is rotating the token. Ignored if undefined. */
  plaintextToken?: string;
  /** For Jira: optional update to email. */
  email?: string;
}

// -- Validation types --------------------------------------------------------

export interface ValidationError {
  /** Dotted path, e.g. "host" or "plaintextToken". Empty for the top-level. */
  path: string;
  /** Stable machine-readable code (consumers may switch on this). */
  code: ValidationErrorCode;
  /** Human-readable message — safe to show in UI. */
  message: string;
}

/**
 * Vocabulary mirrors `project-instance.ts` plus `INVALID_HOST` for host fields
 * that must start with `http://` or `https://`.
 */
export type ValidationErrorCode =
  | 'REQUIRED'
  | 'NOT_STRING'
  | 'NOT_NUMBER'
  | 'NOT_OBJECT'
  | 'EMPTY'
  | 'INVALID_ENUM'
  | 'INVALID_ID'
  | 'INVALID_HOST';

export type ValidationResult =
  | { ok: true; value: Connection }
  | { ok: false; errors: ValidationError[] };

export type ValidationInputResult =
  | { ok: true; value: ConnectionInput }
  | { ok: false; errors: ValidationError[] };

export type ValidationUpdateResult =
  | { ok: true; value: ConnectionUpdate }
  | { ok: false; errors: ValidationError[] };

// -- Validator helpers -------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkString(
  errors: ValidationError[],
  path: string,
  value: unknown,
  opts: { allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    errors.push({ path, code: 'REQUIRED', message: `${path} is required` });
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({ path, code: 'NOT_STRING', message: `${path} must be a string` });
    return undefined;
  }
  if (!opts.allowEmpty && value.trim() === '') {
    errors.push({ path, code: 'EMPTY', message: `${path} must not be empty` });
    return undefined;
  }
  return value;
}

function checkOptionalString(
  errors: ValidationError[],
  path: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({ path, code: 'NOT_STRING', message: `${path} must be a string` });
    return undefined;
  }
  return value;
}

function checkEnum<T extends string>(
  errors: ValidationError[],
  path: string,
  value: unknown,
  allowed: ReadonlyArray<T>,
): T | undefined {
  if (value === undefined || value === null) {
    errors.push({ path, code: 'REQUIRED', message: `${path} is required` });
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({ path, code: 'NOT_STRING', message: `${path} must be a string` });
    return undefined;
  }
  if (!(allowed as ReadonlyArray<string>).includes(value)) {
    errors.push({
      path,
      code: 'INVALID_ENUM',
      message: `${path} must be one of: ${allowed.join(', ')}`,
    });
    return undefined;
  }
  return value as T;
}

/**
 * Push an INVALID_HOST error if the trimmed host doesn't begin with one of
 * the supported schemes. Returns the trimmed string (with any trailing
 * slashes stripped) on success, undefined on failure.
 */
function checkHost(
  errors: ValidationError[],
  path: string,
  value: string,
): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.push({ path, code: 'EMPTY', message: `${path} must not be empty` });
    return undefined;
  }
  if (!/^https?:\/\//.test(trimmed)) {
    errors.push({
      path,
      code: 'INVALID_HOST',
      message: `${path} must start with http:// or https://`,
    });
    return undefined;
  }
  return trimmed.replace(/\/+$/, '');
}

// -- Public validators -------------------------------------------------------

/**
 * Validates a stored Connection. Reports ALL field errors at once.
 */
export function validateConnection(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    errors.push({ path: '', code: 'NOT_OBJECT', message: 'input must be an object' });
    return { ok: false, errors };
  }

  const id = checkString(errors, 'id', input['id']);
  const provider = checkEnum(errors, 'provider', input['provider'], PROVIDERS);
  const label = checkString(errors, 'label', input['label']);
  const hostRaw = checkString(errors, 'host', input['host']);
  let host: string | undefined;
  if (hostRaw !== undefined) {
    host = checkHost(errors, 'host', hostRaw);
  }
  const authMethod = checkEnum(errors, 'authMethod', input['authMethod'], AUTH_METHODS);
  const secretRef = checkString(errors, 'secretRef', input['secretRef']);

  // createdAt / updatedAt: must be finite numbers.
  const createdAt = input['createdAt'];
  const updatedAt = input['updatedAt'];
  if (createdAt === undefined || createdAt === null) {
    errors.push({ path: 'createdAt', code: 'REQUIRED', message: 'createdAt is required' });
  } else if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    errors.push({
      path: 'createdAt',
      code: 'NOT_NUMBER',
      message: 'createdAt must be a finite number',
    });
  }
  if (updatedAt === undefined || updatedAt === null) {
    errors.push({ path: 'updatedAt', code: 'REQUIRED', message: 'updatedAt is required' });
  } else if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    errors.push({
      path: 'updatedAt',
      code: 'NOT_NUMBER',
      message: 'updatedAt must be a finite number',
    });
  }

  // lastVerifiedAt is optional; if present must be a finite number.
  const lastVerifiedAt = input['lastVerifiedAt'];
  if (lastVerifiedAt !== undefined && lastVerifiedAt !== null) {
    if (typeof lastVerifiedAt !== 'number' || !Number.isFinite(lastVerifiedAt)) {
      errors.push({
        path: 'lastVerifiedAt',
        code: 'NOT_NUMBER',
        message: 'lastVerifiedAt must be a finite number',
      });
    }
  }

  // accountIdentity is optional; we do shallow shape checking only — the
  // provider field tells us which sub-shape, but we don't need to enforce
  // it at storage time (the test handler is the only writer).
  const accountIdentityRaw = input['accountIdentity'];
  let accountIdentity: ConnectionIdentity | undefined;
  if (accountIdentityRaw !== undefined && accountIdentityRaw !== null) {
    if (!isPlainObject(accountIdentityRaw)) {
      errors.push({
        path: 'accountIdentity',
        code: 'NOT_OBJECT',
        message: 'accountIdentity must be an object',
      });
    } else {
      // Best-effort cast — runtime callers (the store) only persist what
      // the test handler produced, so we don't deep-validate every field.
      accountIdentity = accountIdentityRaw as ConnectionIdentity;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: Connection = {
    id: id as string,
    provider: provider as Provider,
    label: label as string,
    host: host as string,
    authMethod: authMethod as AuthMethod,
    secretRef: secretRef as string,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
  };
  if (typeof lastVerifiedAt === 'number') {
    value.lastVerifiedAt = lastVerifiedAt;
  }
  if (accountIdentity !== undefined) {
    value.accountIdentity = accountIdentity;
  }
  return { ok: true, value };
}

/**
 * Convenience for the create-flow: validates an input where id / secretRef /
 * timestamps are filled in by the store. If `id` is present on the input we
 * reject with INVALID_ID — the store owns id assignment.
 *
 * Also enforces `email` is required when `provider === 'jira' && authMethod
 * === 'api-token'` (Basic-auth construction needs both halves).
 */
export function validateConnectionInput(input: unknown): ValidationInputResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    errors.push({ path: '', code: 'NOT_OBJECT', message: 'input must be an object' });
    return { ok: false, errors };
  }

  if ('id' in input && input['id'] !== undefined) {
    errors.push({
      path: 'id',
      code: 'INVALID_ID',
      message: 'id must not be supplied on create — the store assigns it',
    });
  }

  const provider = checkEnum(errors, 'provider', input['provider'], PROVIDERS);
  const label = checkString(errors, 'label', input['label']);
  const hostRaw = checkString(errors, 'host', input['host']);
  let host: string | undefined;
  if (hostRaw !== undefined) {
    host = checkHost(errors, 'host', hostRaw);
  }
  const authMethod = checkEnum(errors, 'authMethod', input['authMethod'], AUTH_METHODS);
  const plaintextToken = checkString(errors, 'plaintextToken', input['plaintextToken']);

  // Jira + api-token requires email (non-empty, trimmed).
  let email: string | undefined;
  const emailRaw = input['email'];
  const isJiraApiToken = provider === 'jira' && authMethod === 'api-token';
  if (isJiraApiToken) {
    if (emailRaw === undefined || emailRaw === null) {
      errors.push({
        path: 'email',
        code: 'REQUIRED',
        message: 'email is required for Jira api-token connections',
      });
    } else if (typeof emailRaw !== 'string') {
      errors.push({ path: 'email', code: 'NOT_STRING', message: 'email must be a string' });
    } else if (emailRaw.trim() === '') {
      errors.push({ path: 'email', code: 'EMPTY', message: 'email must not be empty' });
    } else {
      email = emailRaw;
    }
  } else {
    // Optional email path — accept if string (kept for forward-compat).
    const optEmail = checkOptionalString(errors, 'email', emailRaw);
    if (optEmail !== undefined && optEmail.trim() !== '') {
      email = optEmail;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: ConnectionInput = {
    provider: provider as Provider,
    label: label as string,
    host: host as string,
    authMethod: authMethod as AuthMethod,
    plaintextToken: plaintextToken as string,
  };
  if (email !== undefined) {
    value.email = email;
  }
  return { ok: true, value };
}

/**
 * Validates an update payload. All fields are optional — an empty object is
 * valid. Provided fields are typechecked; `plaintextToken` if present must
 * be non-empty (rotation rule).
 */
export function validateConnectionUpdate(input: unknown): ValidationUpdateResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    errors.push({ path: '', code: 'NOT_OBJECT', message: 'input must be an object' });
    return { ok: false, errors };
  }

  const value: ConnectionUpdate = {};

  if (input['label'] !== undefined) {
    const v = checkString(errors, 'label', input['label']);
    if (v !== undefined) value.label = v;
  }
  if (input['host'] !== undefined) {
    const raw = checkString(errors, 'host', input['host']);
    if (raw !== undefined) {
      const checked = checkHost(errors, 'host', raw);
      if (checked !== undefined) value.host = checked;
    }
  }
  if (input['plaintextToken'] !== undefined) {
    const v = checkString(errors, 'plaintextToken', input['plaintextToken']);
    if (v !== undefined) value.plaintextToken = v;
  }
  if (input['email'] !== undefined) {
    const v = checkString(errors, 'email', input['email']);
    if (v !== undefined) value.email = v;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}
