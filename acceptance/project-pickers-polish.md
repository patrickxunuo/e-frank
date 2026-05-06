# Project Pickers Polish + GitHub Issues Source — Acceptance Criteria

Companion to `acceptance/project-connection-pickers.md` (#25). Bundled into the same PR.

## Description (client-readable)

Five items, polish-and-extend on top of the #25 picker UI:
1. ProjectStore init no longer brick-fails on incompatible files (handled in a separate commit; see ProjectStore changes).
2. **Searchable Dropdown** — adds a search input on top of the option list.
3. **Folder picker** for Repository Path — Browse… button via Electron's native `dialog.showOpenDialog`.
4. **Branch picker** — Base Branch becomes a Dropdown populated from the picked GitHub repo's branches; defaults to the repo's `defaultBranch`.
5. **GitHub Issues as a ticket source** — `tickets.source` extends to `'github-issues'`. Tickets section becomes provider-aware. Issues poller dispatched when `source === 'github-issues'`.

## File Structure (additions)

```
src/
├── shared/
│   ├── ipc.ts                                     # MODIFY — DIALOG_SELECT_FOLDER, CONNECTIONS_LIST_BRANCHES, CONNECTIONS_LIST_GITHUB_ISSUES (poller use)
│   └── schema/
│       ├── project-instance.ts                    # MODIFY — TicketSource adds 'github-issues'; TicketsConfig becomes a discriminated union
│       └── ticket.ts                              # MODIFY — add ticketFromGithubIssue() mapper
├── main/
│   ├── index.ts                                   # MODIFY — register dialog handler + listBranches handler; init TicketPoller for both Jira and GitHub Issues
│   └── modules/
│       ├── github-client.ts                       # MODIFY — add listBranches() and listIssues()
│       ├── jira-poller.ts                         # MODIFY → RENAMED to ticket-poller.ts; generic per-project ticket poller dispatching by source
│       └── github-issues-source.ts                # NEW (ticket source strategy)
│       └── jira-source.ts                         # NEW (ticket source strategy — extracted from old JiraPoller)
├── preload/
│   └── index.ts                                   # MODIFY — add window.api.dialog.selectFolder + connections.listBranches
└── renderer/
    ├── components/
    │   ├── Dropdown.tsx                           # MODIFY — searchable prop
    │   └── Dropdown.module.css                    # MODIFY — search input + filter input styles
    ├── state/
    │   └── connection-resources.ts                # MODIFY — add useConnectionBranches hook
    └── views/
        ├── AddProject.tsx                         # MODIFY — Browse button, branch dropdown, GitHub Issues source path
        └── AddProject.module.css                  # MINOR
```

## Item 2 — Searchable Dropdown

`src/renderer/components/Dropdown.tsx`:

- Add `searchable?: boolean` prop. Default false.
- When `searchable && open`, render a thin `<input type="text">` at the top of the menu (above the options list) with placeholder "Search…".
- Maintain `searchQuery` state inside Dropdown; reset to '' when menu closes.
- Filter options client-side: case-insensitive `option.label.toLowerCase().includes(query.toLowerCase())`.
- Highlighted index resets to 0 (or the first non-disabled match) on every filter change. Arrow keys navigate the FILTERED set.
- Search input is auto-focused on menu open.
- Tests: `CMP-DROPDOWN-013` (search filters options), `CMP-DROPDOWN-014` (arrow keys navigate filtered set), `CMP-DROPDOWN-015` (search input cleared on close).
- testid: `{testid}-search` on the search input.

## Item 3 — Folder picker

`src/shared/ipc.ts`:
- Add `DIALOG_SELECT_FOLDER: 'dialog:select-folder'` channel.
- Type:
  ```ts
  export interface DialogSelectFolderRequest {
    /** Optional starting directory; falls back to OS default. */
    defaultPath?: string;
    /** Window title for the OS dialog. */
    title?: string;
  }
  export interface DialogSelectFolderResponse {
    /** `null` when the user cancels. */
    path: string | null;
  }
  ```
- Extend `IpcApi` with `dialog: { selectFolder: (req) => Promise<IpcResult<DialogSelectFolderResponse>> }`.

`src/main/index.ts`:
- Register handler: `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title, defaultPath })`. On `canceled === true`, return `{ path: null }`. Otherwise return `{ path: filePaths[0] }`.

`src/preload/index.ts`:
- Add `dialog: { selectFolder: (req) => ipcRenderer.invoke(DIALOG_SELECT_FOLDER, req) }`.

`src/renderer/views/AddProject.tsx`:
- The Repository Path `<Input>` keeps its `leadingIcon={<IconFolder />}` and gains a "Browse…" button on its trailing side. The button calls `window.api.dialog.selectFolder({ title: 'Select repository folder' })`. On success and non-null path, `set('repoLocalPath', result.data.path)`. On cancel: no-op.
- testid: `field-repo-local-path-browse`.

## Item 4 — Branch picker

`src/main/modules/github-client.ts`:
- Add `GithubBranchSummary { name: string; protected: boolean }` and `listBranches(slug: string): Promise<GithubResult<GithubBranchSummary[]>>`. URL: `${host}/repos/${slug}/branches?per_page=100`. Same security rules.

`src/shared/ipc.ts`:
- Add `CONNECTIONS_LIST_BRANCHES: 'connections:list-branches'`.
- `ConnectionsListBranchesRequest { connectionId: string; slug: string }`, `Response { branches: Array<{ name: string; protected: boolean }> }`.
- Extend `IpcApi.connections.listBranches`.

`src/main/index.ts`:
- Handler: validate request, get connection, ensure provider is 'github', read secret, build GithubClient, call `listBranches(slug)`, return mapped result.

`src/renderer/state/connection-resources.ts`:
- Add `BranchSummary { name: string; protected: boolean }` and `useConnectionBranches(connectionId: string | null, slug: string | null)`.
- Cache key: `${connectionId}::${slug}`.
- Same idle-when-null rule, per-effect cancel flag, per-session cache.
- Export `__resetConnectionResourceCaches` to clear all three caches.

`src/renderer/views/AddProject.tsx`:
- Replace the Base Branch `<Input>` with a `<Dropdown searchable>` populated from `useConnectionBranches(repoConnectionId, repoSlug)`.
- Default selection: the picked repo's `defaultBranch` (from the listRepos cached entry). When `repoSlug` changes, set `repoBaseBranch` to the new repo's default branch.
- Disabled until a repo is picked. testid `field-repo-base-branch` stays on the hidden select.
- testid for the refresh button: `add-project-branch-refresh`.

## Item 5 — GitHub Issues as a ticket source

### Schema changes

`src/shared/schema/project-instance.ts`:

```ts
export const TICKET_SOURCES = ['jira', 'github-issues'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

// Discriminated union — different shape per source.
export type TicketsConfig =
  | TicketsJiraConfig
  | TicketsGithubIssuesConfig;

export interface TicketsJiraConfig {
  source: 'jira';
  connectionId: string;
  /** Jira project key, e.g. 'PROJ'. */
  projectKey: string;
  /** Optional JQL override. Defaults to `project = "{projectKey}"`. */
  query?: string;
}

export interface TicketsGithubIssuesConfig {
  source: 'github-issues';
  connectionId: string;
  /** Repo to read issues from. Per #25's user comment: defaults to the
   *  project's source repo (`repo.slug`); user can override via the picker. */
  repoSlug: string;
  /** Optional label filter, comma-separated (matches GitHub's API). */
  labels?: string;
}
```

Validator updates:
- `validateTickets`: dispatch on `source`. For 'jira', existing rules. For 'github-issues': require `connectionId`, `repoSlug`. `labels` optional, non-empty if present.

Drift guard: still rejects old `host`, `email`, `tokenRef` fields.

### Ticket mapper

`src/shared/schema/ticket.ts`:
- Existing `Ticket` shape stays unchanged — fields (`key`, `summary`, `status`, `priority`, `assignee`, `updatedAt`, `url`) accommodate both providers.
- New `ticketFromGithubIssue(input: unknown, repoSlug: string): Ticket | null`:
  - `key`: `${repoSlug}#${input.number}` (e.g., `gazhang/foo#123`).
  - `summary`: `input.title`.
  - `status`: `'Open'` if `input.state === 'open'`, `'Closed'` if `'closed'`.
  - `priority`: derived from labels — if any label matches `/^priority\/(high|medium|low)$/i`, use that; else `'—'`.
  - `assignee`: `input.assignee?.login` if present, else null.
  - `updatedAt`: `input.updated_at`.
  - `url`: `input.html_url`.

### GithubClient

Add `listIssues(slug: string, opts: { state?: 'open'|'closed'|'all'; labels?: string; perPage?: number }): Promise<GithubResult<unknown[]>>`. Returns the raw GitHub issue array (mapper happens in the source strategy). URL: `${host}/repos/${slug}/issues?state=${state ?? 'open'}&per_page=${perPage ?? 100}${labels ? `&labels=${encodeURIComponent(labels)}` : ''}`.

NOTE: `/repos/{slug}/issues` returns BOTH issues AND PRs by default. PRs are denoted by `pull_request` field on the issue object. The source strategy filters PRs out before mapping to `Ticket`.

### Generic TicketPoller refactor

The old `src/main/modules/jira-poller.ts` is renamed to `src/main/modules/ticket-poller.ts` and refactored:

- Per-project state, mutex, back-off, eligibility filter, run-history checks, ticketsDiffer — ALL stay.
- Auth resolution + actual fetch becomes a strategy pattern. Two source strategies:

```ts
// src/main/modules/jira-source.ts
export interface TicketSourceClient {
  fetchTickets(): Promise<{
    ok: true; tickets: Ticket[];
  } | {
    ok: false;
    code: 'AUTH' | 'NETWORK' | 'TIMEOUT' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'NO_TOKEN' | 'INVALID_RESPONSE';
    message: string;
    httpStatus?: number;
  }>;
}

export async function buildJiraSource(
  project: ProjectInstance,
  deps: { connectionStore, secretsManager, httpClient }
): Promise<{ ok: true; client: TicketSourceClient } | { ok: false; code: 'NO_TOKEN'; message: string }>;
```

Same shape for `buildGithubIssuesSource`. The TicketPoller calls `buildSourceForProject(project)` which dispatches by `project.tickets.source` and returns the appropriate strategy.

Renaming consequences:
- `JiraPollerOptions` → `TicketPollerOptions`. The `jiraClientFactory` is replaced by an internal `sourceFactory` that's only useful for tests.
- `runConnectionTest` (in main/index.ts) stays — it's separate from the poller and only tests credentials, not actual fetches.
- All references in main/index.ts updated.

### IPC + UI

NO new IPC channel needed for issue listing — the UI's "tickets repo picker" reuses `connections:list-repos`. The poller's `listIssues` is a private call inside main.

`src/renderer/views/AddProject.tsx`:
- Tickets section header: "Tickets". Subtitle adapts.
- New `ticketsSource` dropdown: `[{ value: 'jira', label: 'Jira' }, { value: 'github-issues', label: 'GitHub Issues' }]`.
- Connection picker filters: `provider === 'github'` for github-issues; `provider === 'jira'` for jira.
- Resource picker:
  - For jira: project key dropdown via `useConnectionJiraProjects`.
  - For github-issues: repo dropdown via `useConnectionRepos`. Default value: `repo.slug` (the source repo) if available; else empty.
- Form state shape becomes:
  ```ts
  interface FormState {
    name: string;
    // Source repo
    repoConnectionId: string;
    repoSlug: string;
    repoLocalPath: string;
    repoBaseBranch: string;
    // Tickets
    ticketsSource: 'jira' | 'github-issues';
    ticketsConnectionId: string;
    ticketsProjectKey: string;       // for jira
    ticketsRepoSlug: string;         // for github-issues
    ticketLabels: string;            // for github-issues (optional)
    ticketQuery: string;             // for jira (optional JQL)
    workflowMode: 'interactive' | 'yolo';
    branchFormat: string;
  }
  ```
- Build the `TicketsConfig` with the correct shape on submit.

testids:
- `field-tickets-source` (the source dropdown — Jira / GitHub Issues)
- `field-tickets-connection` (existing)
- `field-tickets-project-key` (jira branch — existing)
- `field-tickets-repo-slug` (github-issues branch — NEW)
- `field-ticket-labels` (github-issues — NEW)
- `field-ticket-query` (jira — existing)

### Empty-state CTA

When `ticketsSource === 'github-issues'` and there are no GitHub connections: show the EmptyState card with "Add GitHub Connection" button (same as the Source picker). The dialog opens with `provider` preselected.

## Business Rules

1. **Schema break is non-blocking now** — incompatible projects file auto-archives + empty store; UI banner notifies.
2. **Dropdown searchable** is opt-in. Existing dropdowns (provider select, repo type) get `searchable={false}` (their option count is 2-3). Repo and branch dropdowns get `searchable={true}`.
3. **Folder picker** uses Electron's native dialog. Returns null on cancel — no error.
4. **Branch dropdown** populates only after the user picks a repo. Defaults to the repo's `defaultBranch`. Switching repos resets the branch to the new default.
5. **GitHub Issues source** uses the project's source repo by default. User can override (the field is editable).
6. **Issues poller filters out PRs** (GitHub's issues endpoint conflates them). Determined by presence of `pull_request` field.
7. **Priority for GitHub Issues** is derived from `priority/high|medium|low` labels; otherwise '—'.
8. **No new runtime deps.** The strategy pattern is plain TypeScript.
9. **All interactive elements** carry `data-testid`.

## API Acceptance Tests

### Searchable Dropdown (CMP-DROPDOWN-XXX additions)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-DROPDOWN-013 | `searchable={true}` renders a search input above options when open | true |
| CMP-DROPDOWN-014 | Typing in the search input filters options (case-insensitive substring) | true |
| CMP-DROPDOWN-015 | Search input cleared when menu closes | true |
| CMP-DROPDOWN-016 | Arrow keys navigate the FILTERED option set | true |
| CMP-DROPDOWN-017 | Search input has testid `{testid}-search` | true |

### Folder picker (DIALOG-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| DIALOG-001 | Channel constant `DIALOG_SELECT_FOLDER === 'dialog:select-folder'` | true |
| DIALOG-002 | IpcApi.dialog.selectFolder is typed correctly | true |
| DIALOG-003 | Browse button on Repository Path field calls dialog.selectFolder | true |
| DIALOG-004 | On success, the path is written to repoLocalPath form state | true |
| DIALOG-005 | On cancel (path: null), repoLocalPath is unchanged | true |

### Branch picker (BRANCH-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| BRANCH-001 | `GithubClient.listBranches(slug)` GETs `${host}/repos/{slug}/branches?per_page=100` | true |
| BRANCH-002 | 200 response → array of `{ name, protected }` | true |
| BRANCH-003 | Token never in error.message | true |
| BRANCH-004 | New IPC channel + IpcApi.connections.listBranches typed | true |
| BRANCH-005 | useConnectionBranches null-when-null, fetches, caches by `${connId}::${slug}` | true |
| BRANCH-006 | AddProject base-branch dropdown disabled when no repo picked | true |
| BRANCH-007 | Default branch selected from listRepos.defaultBranch when repo picked | true |
| BRANCH-008 | Switching repo resets branch to new repo's default | true |

### GitHub Issues source (GH-ISSUES-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GH-ISSUES-SCH-001 | TICKET_SOURCES includes 'github-issues' | true |
| GH-ISSUES-SCH-002 | TicketsConfig is a discriminated union; jira branch validates as before | true |
| GH-ISSUES-SCH-003 | github-issues branch requires connectionId + repoSlug | true |
| GH-ISSUES-SCH-004 | github-issues branch accepts optional `labels` | true |
| GH-ISSUES-MAP-001 | `ticketFromGithubIssue` maps title/state/assignee/updated_at/url correctly | true |
| GH-ISSUES-MAP-002 | `ticketFromGithubIssue` derives priority from `priority/high|medium|low` labels | true |
| GH-ISSUES-MAP-003 | `ticketFromGithubIssue` returns null for PR-shaped objects (has pull_request field) | true |
| GH-ISSUES-MAP-004 | Key format: `${repoSlug}#${number}` | true |
| GH-ISSUES-CLIENT-001 | `GithubClient.listIssues(slug, opts)` GETs `/repos/{slug}/issues?state=open&per_page=100` | true |
| GH-ISSUES-CLIENT-002 | `labels` opt URL-encoded into the query string | true |
| GH-ISSUES-CLIENT-003 | Token never in error.message | true |
| GH-ISSUES-POLLER-001 | TicketPoller dispatches to GitHub Issues source when project.tickets.source === 'github-issues' | true |
| GH-ISSUES-POLLER-002 | Issues fetch path resolves auth via the connection (same as Jira path) | true |
| GH-ISSUES-POLLER-003 | PRs returned by GitHub's /issues endpoint are filtered out (pull_request !== undefined) | true |
| GH-ISSUES-VIEW-001 | AddProject Tickets section shows source dropdown when applicable | true |
| GH-ISSUES-VIEW-002 | Picking 'github-issues' source filters connection picker to `provider === 'github'` | true |
| GH-ISSUES-VIEW-003 | Picking 'github-issues' shows repo picker pre-filled with the source repo's slug | true |
| GH-ISSUES-VIEW-004 | Submit builds the github-issues TicketsConfig shape | true |

## Test Status
- [ ] CMP-DROPDOWN-013..017
- [ ] DIALOG-001..005
- [ ] BRANCH-001..008
- [ ] GH-ISSUES-SCH-001..004
- [ ] GH-ISSUES-MAP-001..004
- [ ] GH-ISSUES-CLIENT-001..003
- [ ] GH-ISSUES-POLLER-001..003
- [ ] GH-ISSUES-VIEW-001..004
- [ ] All prior tests still pass
- [ ] `npm run lint`: 0
- [ ] `npm run typecheck`: 0
- [ ] `npm run build`: clean
