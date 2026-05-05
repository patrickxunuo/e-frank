/**
 * Project Instance schema + hand-rolled per-field validator.
 *
 * The validator collects ALL field errors before returning (not first-error-
 * and-stop) so the form can surface every problem inline. Codes are stable
 * machine-readable identifiers; messages are safe to display in UI.
 *
 * No external validator library and no Node-only imports — the renderer
 * imports types from this file via shared/ipc, so it must remain pure.
 */

/**
 * Cross-platform "is absolute path" check. Inlined here (rather than
 * `node:path`) so this module stays renderer-safe.
 *
 *  - POSIX: starts with `/`
 *  - Windows: starts with a drive-letter root (`C:\`, `C:/`) or a UNC root
 *    (`\\server\share`, `//server/share`)
 *
 * Mirrors the cases `path.isAbsolute` covers on each platform; combined here
 * because validation happens once on the user's input regardless of where
 * the renderer is running.
 */
function pathIsAbsolute(p: string): boolean {
  if (p.length === 0) return false;
  // POSIX absolute
  if (p[0] === '/') return true;
  // UNC: \\server\share or //server/share
  if (p.length >= 2 && (p[0] === '\\' || p[0] === '/') && p[0] === p[1]) return true;
  // Windows drive: e.g. C:\ or C:/
  if (
    p.length >= 3 &&
    /^[A-Za-z]$/.test(p[0]!) &&
    p[1] === ':' &&
    (p[2] === '\\' || p[2] === '/')
  ) {
    return true;
  }
  return false;
}

// -- Const enums -------------------------------------------------------------

export const REPO_TYPES = ['github', 'bitbucket'] as const;
export type RepoType = (typeof REPO_TYPES)[number];

export const TICKET_SOURCES = ['jira'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

export const WORKFLOW_MODES = ['interactive', 'yolo'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

// -- Domain types ------------------------------------------------------------

export interface RepoConfig {
  type: RepoType;
  /** Absolute path. */
  localPath: string;
  baseBranch: string;
  /** Optional ref into SecretsManager (e.g. "github-default"). Plaintext tokens NEVER live in this struct. */
  tokenRef?: string;
}

export interface TicketsConfig {
  source: TicketSource;
  /** JQL or equivalent — non-empty after trim. */
  query: string;
  /** Optional ref into SecretsManager for Jira/Bitbucket creds. */
  tokenRef?: string;
}

export interface WorkflowConfig {
  mode: WorkflowMode;
  /** Branch name format. Must contain at least one of {ticketKey} / {slug}. */
  branchFormat: string;
}

export interface ProjectInstance {
  /** UUID v4 generated on create. Stable across edits. */
  id: string;
  name: string;
  repo: RepoConfig;
  tickets: TicketsConfig;
  workflow: WorkflowConfig;
  /** Epoch ms — set on create. */
  createdAt: number;
  /** Epoch ms — bumped on every update. */
  updatedAt: number;
}

export interface ProjectInstanceInput {
  name: string;
  repo: RepoConfig;
  tickets: TicketsConfig;
  workflow: WorkflowConfig;
}

// -- Validation types --------------------------------------------------------

export interface ValidationError {
  /** Dotted path, e.g. "repo.localPath" or "tickets.query". Empty for the top-level. */
  path: string;
  /** Stable machine-readable code (consumers may switch on this). */
  code: ValidationErrorCode;
  /** Human-readable message — safe to show in UI. */
  message: string;
}

/**
 * `NOT_OBJECT` is reserved for the top-level "input is not an object" case
 * (e.g. `null`, an array, or a primitive). `NOT_STRING` is used for any
 * field that should be a string but isn't.
 */
export type ValidationErrorCode =
  | 'REQUIRED'
  | 'NOT_STRING'
  | 'NOT_NUMBER'
  | 'NOT_OBJECT'
  | 'EMPTY'
  | 'INVALID_ENUM'
  | 'NOT_ABSOLUTE'
  | 'INVALID_BRANCH_FORMAT'
  | 'INVALID_ID';

export type ValidationResult =
  | { ok: true; value: ProjectInstance }
  | { ok: false; errors: ValidationError[] };

export type ValidationInputResult =
  | { ok: true; value: ProjectInstanceInput }
  | { ok: false; errors: ValidationError[] };

// -- Validator helpers -------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function joinPath(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`;
}

/**
 * Validates a non-empty string. Pushes errors into `errors` and returns the
 * trimmed value on success (or `undefined` on failure so callers can skip
 * downstream checks).
 */
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
  if (value === undefined) {
    return undefined;
  }
  // null is treated like absent — silently dropped.
  if (value === null) {
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

function validateRepo(
  errors: ValidationError[],
  path: string,
  raw: unknown,
): RepoConfig | undefined {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: 'NOT_OBJECT', message: `${path} must be an object` });
    return undefined;
  }
  const type = checkEnum(errors, joinPath(path, 'type'), raw['type'], REPO_TYPES);
  const localPathRaw = checkString(errors, joinPath(path, 'localPath'), raw['localPath']);
  if (localPathRaw !== undefined && !pathIsAbsolute(localPathRaw)) {
    errors.push({
      path: joinPath(path, 'localPath'),
      code: 'NOT_ABSOLUTE',
      message: `${joinPath(path, 'localPath')} must be an absolute path`,
    });
  }
  const baseBranch = checkString(errors, joinPath(path, 'baseBranch'), raw['baseBranch']);
  const tokenRef = checkOptionalString(errors, joinPath(path, 'tokenRef'), raw['tokenRef']);

  if (
    type === undefined ||
    localPathRaw === undefined ||
    baseBranch === undefined ||
    !pathIsAbsolute(localPathRaw)
  ) {
    return undefined;
  }
  const result: RepoConfig = { type, localPath: localPathRaw, baseBranch };
  if (tokenRef !== undefined) {
    result.tokenRef = tokenRef;
  }
  return result;
}

function validateTickets(
  errors: ValidationError[],
  path: string,
  raw: unknown,
): TicketsConfig | undefined {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: 'NOT_OBJECT', message: `${path} must be an object` });
    return undefined;
  }
  const source = checkEnum(errors, joinPath(path, 'source'), raw['source'], TICKET_SOURCES);
  const query = checkString(errors, joinPath(path, 'query'), raw['query']);
  const tokenRef = checkOptionalString(errors, joinPath(path, 'tokenRef'), raw['tokenRef']);

  if (source === undefined || query === undefined) {
    return undefined;
  }
  const result: TicketsConfig = { source, query };
  if (tokenRef !== undefined) {
    result.tokenRef = tokenRef;
  }
  return result;
}

function validateWorkflow(
  errors: ValidationError[],
  path: string,
  raw: unknown,
): WorkflowConfig | undefined {
  if (!isPlainObject(raw)) {
    errors.push({ path, code: 'NOT_OBJECT', message: `${path} must be an object` });
    return undefined;
  }
  const mode = checkEnum(errors, joinPath(path, 'mode'), raw['mode'], WORKFLOW_MODES);
  const branchFormatRaw = checkString(errors, joinPath(path, 'branchFormat'), raw['branchFormat']);
  if (
    branchFormatRaw !== undefined &&
    !branchFormatRaw.includes('{ticketKey}') &&
    !branchFormatRaw.includes('{slug}')
  ) {
    errors.push({
      path: joinPath(path, 'branchFormat'),
      code: 'INVALID_BRANCH_FORMAT',
      message: `${joinPath(path, 'branchFormat')} must contain at least one of {ticketKey} or {slug}`,
    });
  }

  if (
    mode === undefined ||
    branchFormatRaw === undefined ||
    (!branchFormatRaw.includes('{ticketKey}') && !branchFormatRaw.includes('{slug}'))
  ) {
    return undefined;
  }
  return { mode, branchFormat: branchFormatRaw };
}

// -- Public validators -------------------------------------------------------

/**
 * Validates a candidate ProjectInstance. Reports ALL field errors at once.
 */
export function validateProjectInstance(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    errors.push({ path: '', code: 'NOT_OBJECT', message: 'input must be an object' });
    return { ok: false, errors };
  }

  const id = checkString(errors, 'id', input['id']);
  const name = checkString(errors, 'name', input['name']);
  const repo = validateRepo(errors, 'repo', input['repo']);
  const tickets = validateTickets(errors, 'tickets', input['tickets']);
  const workflow = validateWorkflow(errors, 'workflow', input['workflow']);

  // createdAt / updatedAt: must be finite numbers if validateProjectInstance
  // is called (this is the post-store shape). Inputs that are missing are
  // treated as REQUIRED.
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

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All fields validated. The non-undefined assertions below are safe because
  // any failure would have pushed an error and returned above.
  const value: ProjectInstance = {
    id: id as string,
    name: name as string,
    repo: repo as RepoConfig,
    tickets: tickets as TicketsConfig,
    workflow: workflow as WorkflowConfig,
    createdAt: createdAt as number,
    updatedAt: updatedAt as number,
  };
  return { ok: true, value };
}

/**
 * Convenience for the create-flow: validates an input where id / createdAt /
 * updatedAt are filled in by the store. If `id` is present on the input we
 * reject with INVALID_ID — the store owns id assignment.
 */
export function validateProjectInstanceInput(input: unknown): ValidationInputResult {
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

  const name = checkString(errors, 'name', input['name']);
  const repo = validateRepo(errors, 'repo', input['repo']);
  const tickets = validateTickets(errors, 'tickets', input['tickets']);
  const workflow = validateWorkflow(errors, 'workflow', input['workflow']);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: ProjectInstanceInput = {
    name: name as string,
    repo: repo as RepoConfig,
    tickets: tickets as TicketsConfig,
    workflow: workflow as WorkflowConfig,
  };
  return { ok: true, value };
}
