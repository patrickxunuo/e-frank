# Project Detail UI — Acceptance Criteria

## Description (client-readable)
Per-project screen showing the live Jira ticket list, multi-select Run controls, per-project Auto Mode toggle, tabs (Tickets active; Runs / PRs / Settings stubs), header metadata, and a sticky Active Execution panel. UI-only for runner/execution wiring — Run buttons emit callbacks that no-op until #7 lands the workflow runner. Reuses the design system from #5; only NEW primitives are `Tabs`, `Checkbox`, `ProgressBar`, `LogPreview`.

## Adaptation Note
This is the **second user-facing UI** feature. Like #5, tests live in two layers:
- Vitest + jsdom (Testing Library) for component logic + integration with stubbed `window.api`
- No new Electron-driven Playwright in this PR

## Interface Contract

### Tech Stack (locked, inherited from #5)
- React 18 + TypeScript strict
- CSS Modules + tokens from #5's `tokens.css`
- No new runtime deps

### File Structure (exact)
```
src/renderer/
├── App.tsx                              # MODIFY — add detail navigation; remove DetailPlaceholder import
├── components/
│   ├── Tabs.tsx                         # NEW
│   ├── Tabs.module.css
│   ├── Checkbox.tsx                     # NEW
│   ├── Checkbox.module.css
│   ├── ProgressBar.tsx                  # NEW
│   ├── ProgressBar.module.css
│   ├── LogPreview.tsx                   # NEW
│   └── LogPreview.module.css
├── lib/
│   ├── time.ts                          # NEW — formatRelative()
│   └── priority.ts                      # NEW — normalizePriority()
├── state/
│   ├── tickets.ts                       # NEW — useTickets(projectId)
│   ├── active-run.ts                    # NEW — useActiveRun() — stub for #7
│   └── auto-mode.ts                     # MODIFY — accept optional projectId for per-project keying
└── views/
    ├── ProjectDetail.tsx                # NEW
    ├── ProjectDetail.module.css
    └── DetailPlaceholder.tsx            # DELETE (and its .module.css)

tests/unit/
├── App.test.tsx                         # MODIFY — APP-007 / APP-008 replace stale DetailPlaceholder cases
├── components-tabs.test.tsx             # NEW
├── components-checkbox.test.tsx         # NEW
├── components-progress.test.tsx         # NEW
├── lib-time.test.ts                     # NEW
├── lib-priority.test.ts                 # NEW
└── views-project-detail.test.tsx        # NEW
```

### Component primitive APIs (exact)

**`<Tabs>`**
```tsx
interface TabItem {
  id: string;
  label: React.ReactNode;
  /** Optional badge/count rendered after the label. */
  badge?: React.ReactNode;
  disabled?: boolean;
}
interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (next: string) => void;
  'data-testid'?: string;
}
```
Renders a horizontal tab strip. The active tab has an animated underline. Each tab is a `<button>` with `role="tab"`. The strip is `role="tablist"`.

**`<Checkbox>`**
```tsx
interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** "indeterminate" displays a horizontal line; checked must be `false` when indeterminate is true. */
  indeterminate?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
}
```
Built on a hidden `<input type="checkbox">`. Click anywhere on the visible box toggles. Indeterminate state shown via CSS, not via the native `.indeterminate` property (we drive it via prop).

**`<ProgressBar>`**
```tsx
interface ProgressBarProps {
  /** 0..1 inclusive. Values outside this range are clamped. */
  value: number;
  /** Optional label rendered above the bar. */
  label?: string;
  /** Optional hint rendered to the right of the label (e.g. "Step 3 of 6"). */
  hint?: string;
  'data-testid'?: string;
}
```

**`<LogPreview>`**
```tsx
interface LogPreviewProps {
  /** Lines to render. Order is top-to-bottom (oldest at top). */
  lines: string[];
  /** Optional max height before scrolling. Default 120px. */
  maxHeight?: number;
  'data-testid'?: string;
}
```
Monospace, terminal-themed, auto-scrolls to bottom on prop change.

### Utilities (exact)

**`formatRelative(iso: string): string`** — returns one of:
- `"now"` — within 60s
- `"{n}m ago"` — within 60min (n is integer minutes)
- `"{n}h ago"` — within 24h
- `"{n}d ago"` — within 7d
- `"{Mon} {D}"` — older than 7d (e.g. `"Jan 5"`)

If the input fails to parse, returns `"—"`.

**`normalizePriority(name: string | null | undefined): 'high' | 'medium' | 'low' | 'neutral'`**
- `'highest' | 'high' | 'urgent' | 'critical' | 'blocker'` → `'high'`
- `'medium' | 'normal'` → `'medium'`
- `'low' | 'lowest' | 'minor' | 'trivial'` → `'low'`
- anything else (including null/undefined/empty) → `'neutral'`
Case-insensitive.

### Hooks (exact)

**`useTickets(projectId: string)`**
```ts
function useTickets(projectId: string): {
  tickets: Ticket[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};
```
Behavior:
- On mount: call `window.api.jira.list({ projectId })` to seed cached eligible tickets
- Subscribe to `window.api.jira.onTicketsChanged` and `onError`; filter events by `projectId`
- `refresh()` calls `window.api.jira.refresh({ projectId })`. Sets `refreshing: true` during the call. On error, sets `error` and returns
- Unsubscribes on unmount (return value of `onTicketsChanged` / `onError`)
- Handles `window.api === undefined` gracefully (returns empty + error)

**`useActiveRun(projectId: string): ActiveRun | null`**
```ts
interface ActiveRun {
  ticketKey: string;
  ticketTitle: string;
  /** 0..1 — derived from currentStep / totalSteps. */
  progress: number;
  currentStep: string;
  totalSteps: number;
  stepIndex: number;
  /** Last few log lines (max 5) — older lines truncated. */
  recentLines: string[];
  runId: string;
}
function useActiveRun(projectId: string): ActiveRun | null;
```
For #6, this hook **always returns `null`** (no live run integration). Hook signature is set up so #7 can replace the implementation without changing call sites. Document this in the source with a clear `// TODO(#7)` comment.

**`useAutoMode(projectId?: string)`** — modify the existing hook from #5:
- If `projectId` is provided: keyed `auto-mode:${projectId}` in localStorage
- If omitted: keyed `auto-mode` (backward compat — preserves the global default-key path even if no caller uses it)

### View — `<ProjectDetail>`

**Props:**
```tsx
interface ProjectDetailProps {
  projectId: string;
  onBack: () => void;
  onOpenExecution: (ticketKey: string) => void;
  onRun: (ticketKey: string) => void;
  onRunSelected: (ticketKeys: string[]) => void;
}
```

**Behavior:**
1. Mount: fetch project via `window.api.projects.get({ id: projectId })`. Loading / error / not-found states render in place of the entire view.
2. Render header bar:
   - Back button (`data-testid="detail-back"`)
   - Project name + metadata pill row (source icon + project key from JQL or "Jira", repo provider icon + path, branch icon + base branch)
   - Right side: `Auto Mode` toggle (`data-testid="auto-mode-toggle"`), `Run Selected` button (`data-testid="run-selected-button"`, disabled when 0 selected), `Refresh` icon button (`data-testid="refresh-button"`, shows spinning state during refresh)
3. Render Tabs: `Tickets`, `Runs`, `Pull Requests`, `Settings` (`data-testid="project-tabs"`). Default `tickets`. Other tabs render an `<EmptyState>` card pointing to their future issues.
4. **Tickets tab body**:
   - `<DataTable>` with columns: master checkbox + per-row checkbox, ID (mono), Title, Priority badge, Source (icon), Last Updated (relative time), Actions (Run button)
   - Each row has `data-testid="ticket-row-{key}"`
   - Master checkbox toggles all visible rows; indeterminate when some-but-not-all selected
   - Run button: `data-testid="ticket-run-button-{key}"` — calls `onRun(key)`
   - Loading / error / empty states inline
5. Active Execution panel (sticky bottom):
   - Hidden when `useActiveRun(projectId) === null`
   - Shown: ticket ID + title, progress bar with "Step X of Y", `LogPreview` of `recentLines`, Cancel button (`data-testid="active-execution-cancel"`), Open Details button (`data-testid="active-execution-open-details"`) → calls `onOpenExecution(ticketKey)`

**Selection state:** `useState<Set<string>>(new Set())`. Reset when ticket list changes.

### App.tsx (modify)
Change `view` state to a discriminated union:
```ts
type ViewState =
  | { kind: 'list' }
  | { kind: 'detail'; projectId: string };
```
- `onOpen(id)` → `setView({ kind: 'detail', projectId: id })`
- `onBack` (from ProjectDetail) → `setView({ kind: 'list' })`
- `onRun(key)` and `onRunSelected(keys)` — log to console + show a transient inline banner ("Workflow runner not yet wired — #7 will land this"). Banner can be dismissed.
- `onOpenExecution(key)` — placeholder for now; logs and shows a banner

Delete `DetailPlaceholder.tsx` and its CSS module. Remove the import from `App.tsx`.

## Business Rules
1. **Reuses the design system from #5**. No new tokens. No new fonts. Only the four new primitives listed above.
2. **Run buttons no-op** for this PR — they emit callbacks. Never call `jira.refresh` or any IPC except via the explicit refresh button + `useTickets` mount path.
3. **Auto Mode is per-project**. Each project's toggle persists independently.
4. **Settings tab is a stub** with a `<EmptyState>` pointing to a future "edit project" issue — does NOT re-implement the AddProject form.
5. **Active Execution panel**: hidden by default (because `useActiveRun() === null`). UI is exercised only via tests that stub the hook.
6. **All interactive elements** have `data-testid`.
7. **Header metadata pills** are read-only — no editing in this PR.
8. **Multi-select Run** runs sequentially (per PRD §10) — but since we no-op, this is just an `onRunSelected(keys[])` callback. Order: visible-table-order of selected keys.
9. **Refresh button** sets `refreshing: true` during the call so the icon spins; clears on success or error. Errors surface as a banner above the table (not blocking).

## API Acceptance Tests

### Component primitives (CMP-TABS / CMP-CHK / CMP-PROG)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-TABS-001 | Renders all items + active underline on the value | true |
| CMP-TABS-002 | Click a non-active tab → onChange fires with that id | true |
| CMP-TABS-003 | Disabled tab — click does NOT fire onChange | true |
| CMP-CHK-001 | `checked={false}` click → onChange(true) | true |
| CMP-CHK-002 | `checked={true}` click → onChange(false) | true |
| CMP-CHK-003 | `indeterminate={true}` renders the dash glyph; click still fires onChange(true) | true |
| CMP-CHK-004 | `disabled` click → onChange NOT called | true |
| CMP-PROG-001 | `value=0.5` renders the fill at 50% width (style `width: 50%`) | true |
| CMP-PROG-002 | `value=-1` clamps to 0; `value=2` clamps to 1 | true |

### Utilities (UTIL-TIME / UTIL-PRI)

| ID | Scenario | Expected |
|----|----------|----------|
| UTIL-TIME-001 | now → "now" | true |
| UTIL-TIME-002 | 5 min ago → "5m ago" | true |
| UTIL-TIME-003 | 3 hours ago → "3h ago" | true |
| UTIL-TIME-004 | 4 days ago → "4d ago" | true |
| UTIL-TIME-005 | 30 days ago → "{Mon} {D}" format | true |
| UTIL-TIME-006 | invalid input → "—" | true |
| UTIL-PRI-001 | "Highest" → 'high'; "blocker" → 'high' | true |
| UTIL-PRI-002 | "Medium" / "normal" → 'medium' | true |
| UTIL-PRI-003 | "Low" / "trivial" → 'low' | true |
| UTIL-PRI-004 | null / undefined / "" / unknown name → 'neutral' | true |

### ProjectDetail view (DET-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| DET-001 | On mount, calls `projects.get({ id })` and renders project name in the header | true |
| DET-002 | Project not found → renders error/not-found banner; no tabs/table rendered | true |
| DET-003 | On mount, calls `jira.list` for the projectId; tickets render | true |
| DET-004 | Refresh button click → calls `jira.refresh` and sets refreshing state | true |
| DET-005 | Empty ticket list → empty state inside Tickets tab; Run Selected disabled | true |
| DET-006 | Auto Mode toggle persists per-project (localStorage key `auto-mode:${projectId}`) | true |
| DET-007 | Per-row Run button click → onRun callback fires with that ticket key | true |
| DET-008 | Multi-select via per-row checkboxes — Run Selected becomes enabled when ≥1 checked; click fires onRunSelected with selected keys in table order | true |
| DET-009 | Master checkbox toggles all visible tickets; indeterminate when some-but-not-all are checked | true |
| DET-010 | Tabs: switching to Runs / PRs / Settings shows empty-state cards; switching back to Tickets restores the table | true |
| DET-011 | Active Execution panel hidden when `useActiveRun()` returns null (default for this PR) | true |
| DET-012 | Active Execution panel rendered (with stubbed run) — Cancel + Open Details buttons; Open Details fires `onOpenExecution(key)` | true |
| DET-013 | Priority badges render with color encoding (high/medium/low/neutral classes via Badge variant) | true |
| DET-014 | Ticket subscription — onTicketsChanged event for THIS projectId updates the table; event for a different projectId does NOT | true |

### App-level (APP-XXX) — replaces APP-003 / APP-004 from #5

| ID | Scenario | Expected |
|----|----------|----------|
| APP-007 | Click Open on a project row → view becomes detail; ProjectDetail header shows project name | replaces #5's APP-003 |
| APP-008 | Detail Back button → view returns to list | replaces #5's APP-004 |

(APP-001/002/005/006 from #5 unchanged. The two replaced tests test the same idea — navigation in/out of detail — but now point at the real ProjectDetail instead of the placeholder.)

## E2E (Playwright) — None in this PR

## Test Status
- [x] CMP-TABS-001..003: PASS (3 tests)
- [x] CMP-CHK-001..004: PASS (4 tests)
- [x] CMP-PROG-001..002: PASS (2 tests)
- [x] UTIL-TIME-001..006: PASS (6 tests)
- [x] UTIL-PRI-001..004: PASS (4 tests)
- [x] DET-001..014: PASS (14 tests)
- [x] APP-007 / APP-008: PASS (replaces #5's APP-003 / APP-004)
- [x] Total project: **335/335 unit tests pass** (was 302/302 after #5; +33 new + 2 replaced)
- [x] `npm run lint`: 0 / 0
- [x] `npm run typecheck`: 0
- [x] `npm run build`: clean — renderer 315.54 kB JS / 40.66 kB CSS

## Manual verification (after PR)
- [ ] `npm run dev` regression: empty state, create a project, click Open → detail view
- [ ] Refresh button works (will fail with NO_TOKEN if Jira isn't configured — banner should show)
- [ ] Auto Mode toggle persists per-project across reloads
- [ ] Tab switching works
