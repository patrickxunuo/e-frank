# Project List UI + Design System Foundation — Acceptance Criteria

## Description (client-readable)
First user-facing screen. Replaces the #1 placeholder Ping demo with the real **app shell**, **Project List** view, and **Add Project** form. Establishes the design-token + component-library foundation that #6 / #7 / #8 / #9 will reuse. Wired end-to-end against `window.api.projects` (#3) and `window.api.secrets` (#3) and `window.api.jira.testConnection` (#4).

## Adaptation Note
This is a **UI-heavy** feature. Tests live in two layers:
- **Vitest + jsdom** (Testing Library) for component logic and integration with stubbed `window.api`
- **No Electron-driven Playwright** in this PR — Phase 5 of the workflow may add a placeholder spec but real Electron-driven E2E lands in a follow-up issue once stable enough

## Interface Contract

### Tech Stack (locked)
- React 18 + TypeScript strict (existing)
- Vite (existing)
- **CSS Modules + tokens** (no Tailwind, no styled-components — bundle stays lean)
- **Typography**: General Sans (display + body) + JetBrains Mono (mono). Loaded via Bunny Fonts (privacy-friendly, no Google call) or self-hosted from `public/fonts/` if Bunny Fonts isn't reliable. Fallback stack: `system-ui, -apple-system, "Segoe UI", sans-serif`.
- **No new runtime deps** required. Add `@testing-library/user-event` if not already present (more realistic event simulation than `fireEvent`).

### File Structure (exact)
```
src/renderer/
├── App.tsx                              # rewritten — thin shell + view switcher
├── App.css                              # rewritten — global resets, imports tokens
├── index.html                           # imports font CSS
├── main.tsx                             # unchanged
├── styles/
│   ├── tokens.css                       # NEW — CSS variables on :root
│   └── reset.css                        # NEW — minimal global reset
├── components/
│   ├── AppShell.tsx                     # sidebar + main layout
│   ├── AppShell.module.css
│   ├── Sidebar.tsx
│   ├── Sidebar.module.css
│   ├── Button.tsx
│   ├── Button.module.css
│   ├── Card.tsx
│   ├── Card.module.css
│   ├── Badge.tsx
│   ├── Badge.module.css
│   ├── Input.tsx
│   ├── Input.module.css
│   ├── Textarea.tsx
│   ├── Select.tsx
│   ├── Toggle.tsx
│   ├── Toggle.module.css
│   ├── DataTable.tsx
│   ├── DataTable.module.css
│   ├── FormSection.tsx
│   ├── FormSection.module.css
│   ├── EmptyState.tsx
│   ├── EmptyState.module.css
│   ├── Dialog.tsx                       # full-screen-ish modal for AddProject
│   ├── Dialog.module.css
│   └── icons.tsx                        # tiny inline SVG icon components
├── views/
│   ├── ProjectList.tsx
│   ├── ProjectList.module.css
│   ├── AddProject.tsx
│   └── AddProject.module.css
└── state/
    ├── projects.ts                      # useProjects() hook
    └── auto-mode.ts                     # useAutoMode() hook (localStorage-backed)

tests/unit/
├── App.test.tsx                         # REWRITTEN — tests new <App />
├── components-button.test.tsx           # NEW
├── components-badge.test.tsx            # NEW
├── components-toggle.test.tsx           # NEW
├── views-project-list.test.tsx          # NEW
├── views-add-project.test.tsx           # NEW
└── tokens.test.ts                       # NEW — token names sanity check
```

### Design tokens (exact CSS variable names)

`src/renderer/styles/tokens.css` — declared on `:root`:
```
/* Surfaces */
--bg-app: #0e0f13;
--bg-sidebar: #14161c;
--bg-card: #1a1d24;
--bg-card-elevated: #232732;
--bg-input: #14161c;
--border-subtle: rgba(255, 255, 255, 0.06);
--border-default: rgba(255, 255, 255, 0.1);
--border-emphasis: rgba(255, 255, 255, 0.18);

/* Brand & status */
--accent: #4d7cff;
--accent-hover: #6b91ff;
--accent-press: #3a64da;
--success: #4ad98a;
--success-soft: rgba(74, 217, 138, 0.14);
--warning: #f0b95c;
--warning-soft: rgba(240, 185, 92, 0.14);
--danger: #f06f6f;
--danger-soft: rgba(240, 111, 111, 0.14);

/* Text */
--text-primary: #ecedf1;
--text-secondary: #8a8f99;
--text-tertiary: #5b606b;
--text-on-accent: #ffffff;

/* Spacing */
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 24px;
--space-6: 32px;
--space-7: 48px;
--space-8: 64px;

/* Radii */
--radius-sm: 6px;
--radius-md: 10px;
--radius-lg: 14px;
--radius-pill: 999px;

/* Shadows */
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
--shadow-md: 0 6px 18px rgba(0, 0, 0, 0.45);
--shadow-glow-accent: 0 0 0 1px rgba(77, 124, 255, 0.4), 0 8px 24px rgba(77, 124, 255, 0.18);

/* Transitions */
--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--duration-fast: 120ms;
--duration-base: 200ms;

/* Typography */
--font-display: "General Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
--font-body: "General Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

### Component primitives (exact public APIs)

**`<Button>`**
```tsx
type ButtonVariant = 'primary' | 'ghost' | 'destructive' | 'icon';
type ButtonSize = 'sm' | 'md';
interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;       // default 'primary'
  size?: ButtonSize;             // default 'md'
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  fullWidth?: boolean;
}
```

**`<Badge>`**
```tsx
type BadgeVariant = 'idle' | 'running' | 'success' | 'warning' | 'danger' | 'neutral';
interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  pulse?: boolean;               // running state shows a pulsing dot
  'data-testid'?: string;
}
```

**`<Card>`**
```tsx
interface CardProps {
  elevated?: boolean;
  children: React.ReactNode;
  className?: string;
}
// + Card.Header, Card.Body, Card.Footer compound slots
```

**`<Input>` / `<Textarea>` / `<Select>`**
```tsx
interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: string;
  error?: string;                // inline error message renders below
  hint?: string;                 // helper text — shown when no error
  leadingIcon?: React.ReactNode;
}
// Textarea analogous; Select wraps native <select> with consistent styling
```

**`<Toggle>`**
```tsx
interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  'data-testid'?: string;
}
```

**`<DataTable>`**
```tsx
interface DataTableColumn<Row> {
  key: string;
  header: React.ReactNode;
  render: (row: Row) => React.ReactNode;
  align?: 'left' | 'right';
  width?: string;                // CSS value
}
interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  emptyState?: React.ReactNode;  // rendered when rows.length === 0
  onRowClick?: (row: Row) => void;
  'data-testid'?: string;
}
```

**`<Dialog>`**
```tsx
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'md' | 'lg' | 'full';   // default 'lg'; AddProject uses 'full'
}
```

### Views

**`ProjectList.tsx`**
- Calls `useProjects()` on mount; renders loading state, then either empty state or table
- Heading: **Projects** (`data-testid="page-title"`)
- Subhead: "Manage and run your AI-powered development projects"
- Top-right: `<Toggle>` for Auto Mode (`data-testid="auto-mode-toggle"`) + `<Button variant="primary">+ New Project</Button>` (`data-testid="new-project-button"`)
- Table columns: Project (icon + name + meta), Repository (provider icon + path), Ticket Source (icon + project key), Status (`<Badge>`), Actions (`<Button variant="ghost">Open →</Button>` per row, `data-testid="project-open-{id}"`)
- Empty state: friendly icon + headline "No projects yet" + subhead + primary CTA "Create your first project"

**`AddProject.tsx`** (rendered inside a `<Dialog size="full">`)
- 4 numbered `<FormSection>` cards:
  1. **Basic Info** — Project Name (`<Input>`)
  2. **Repository Configuration** — Repository Type (`<Select>`: GitHub / Bitbucket), Repository Path (`<Input>` with file-icon), Base Branch (`<Input>`), optional Personal Access Token (`<Input type="password">`) — only shown when type !== github+anonymous (we'll just always show it for MVP)
  3. **Ticket Source** — Ticket Source Type (`<Select>`: Jira), Ticket Query (`<Textarea>`, monospace, JQL), Jira Host (`<Input>`), Jira Email (`<Input type="email">`), Jira API Token (`<Input type="password">`), small `<Button variant="ghost" size="sm">Test connection</Button>`
  4. **Workflow Settings** — Mode (two side-by-side selectable cards: Interactive / YOLO with descriptive copy), Branch Naming Format (`<Input>`, monospace, with `{ticketKey}` / `{slug}` placeholder hint)
- Bottom action bar: `<Button variant="ghost">Cancel</Button>` + `<Button variant="primary">Create Project</Button>`
- Submit flow:
  1. Run `validateProjectInstanceInput` from `@shared/schema`. If errors, display each per-field via `<Input error="...">` and abort.
  2. If repo token provided, call `secrets.set(`{projectName-slug}-repo`, plaintext)`. If fails, show banner "Failed to save repo token: {message}" and abort.
  3. If Jira token provided, call `secrets.set(`{projectName-slug}-jira`, plaintext)`. If fails, banner + abort. (Spec rule 8.)
  4. Call `projects.create({ input: { ...withTokenRefs } })`. If fails, banner + abort.
  5. On success: `onCreated()` callback; parent closes dialog and refreshes list.
- Test Connection button:
  - Reads current values of host/email/Jira-API-token from form state
  - Calls `window.api.jira.testConnection({ host, email, apiToken })`
  - Renders inline pill: success ("Connected as {displayName}") or error ("AUTH" / "NETWORK" / etc.)

### `useProjects()` hook
```ts
function useProjects(): {
  projects: ProjectInstance[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};
```
On mount: calls `window.api.projects.list()`. Exposes `refresh` so `AddProject.onCreated` can re-fetch.

### `useAutoMode()` hook
- Backed by `localStorage.getItem('auto-mode')` / `setItem`. Returns `[autoMode: boolean, setAutoMode: (b) => void]`. Persists across reloads. (No IPC needed for a UI-only preference; MVP simplicity.)

### App.tsx (rewrite)
```tsx
function App() {
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [addOpen, setAddOpen] = useState(false);
  const [_currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const projects = useProjects();

  return (
    <AppShell activeNav="projects">
      {view === 'list' && (
        <ProjectList
          projects={projects.projects}
          loading={projects.loading}
          error={projects.error}
          onRefresh={projects.refresh}
          onAdd={() => setAddOpen(true)}
          onOpen={(id) => { setCurrentProjectId(id); setView('detail'); }}
        />
      )}
      {view === 'detail' && (
        <DetailPlaceholder onBack={() => setView('list')} />
      )}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} size="full" title="Add Project" subtitle="Configure repository, ticket source, and workflow settings.">
        <AddProject
          onClose={() => setAddOpen(false)}
          onCreated={async () => {
            setAddOpen(false);
            await projects.refresh();
          }}
        />
      </Dialog>
    </AppShell>
  );
}

export default App;
```

`<DetailPlaceholder>` is a tiny placeholder rendering "Project detail view lands in #6" with a back button.

## Business Rules
1. **Branding**: app uses **e-frank** as the product name in the sidebar logo, page title, and all text. (See PR body for the override path if "AI Runner" is preferred.)
2. **Form validation runs synchronously in the renderer** via `validateProjectInstanceInput` — no round-trip to main process for invalid inputs.
3. **Token-set before project-create**: rule 8 above. If a token-set fails, the project is NOT created (avoids dangling tokenRef).
4. **Auto Mode is a UI-only persisted flag** in localStorage. The poller hook-up to this flag is in #6.
5. **Empty projects list shows the empty state**, not an empty table. The empty state's CTA also opens the Add Project dialog.
6. **All interactive elements MUST have `data-testid`** for E2E.
7. **Detail navigation goes to a placeholder** in this PR; #6 will replace it.
8. **Production design quality**: dark theme, distinctive type pairing (NOT Inter/Roboto/Arial), CSS-variable-driven tokens, deliberate negative space, micro-interactions on hover/focus, accessible focus rings.
9. **The IPC ping flow from #1 stays available at the contract level** (PING channel still exists, handler still registered) — but the placeholder UI that exercised it is removed. Tests covering the contract (`ipc-contract.test.ts`) keep passing.
10. **Renderer never imports Node modules** — schema validator is renderer-safe.

## API Acceptance Tests (component / view level)

### Token sanity (TOKEN-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| TOKEN-001 | `tokens.css` declares all expected variable names | Reading the file as text contains each name listed in spec |

### Component primitives (CMP-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-BTN-001 | `<Button>` default variant renders `data-testid` and emits onClick | onClick called once on click |
| CMP-BTN-002 | `<Button variant="ghost">` has distinct class from primary | DOM has different className |
| CMP-BTN-003 | `<Button disabled>` does not fire onClick when clicked | onClick NOT called |
| CMP-BDG-001 | `<Badge variant="idle">` renders with badge-idle class | true |
| CMP-BDG-002 | `<Badge variant="running" pulse>` renders the pulsing dot element | element with `data-pulse-dot` is present |
| CMP-TGL-001 | `<Toggle checked={false}>` clicked → onChange(true) | true |
| CMP-TGL-002 | `<Toggle disabled>` clicked → onChange NOT called | true |

### Project List view (LIST-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| LIST-001 | Renders heading + subhead + Auto Mode + New Project button | All visible |
| LIST-002 | Empty state shown when `projects.list()` returns `[]` | Empty state visible; table NOT visible; CTA `data-testid="empty-state-cta"` opens dialog |
| LIST-003 | Populated state shows N rows from `projects.list()` | N table rows; each row has `data-testid="project-row-{id}"` |
| LIST-004 | Click `+ New Project` → dialog opens | dialog visible |
| LIST-005 | Click `Open →` on a row → onOpen callback fires with that row's id | id arg matches |
| LIST-006 | Auto Mode toggle persists to localStorage on change | localStorage key `auto-mode` updated |
| LIST-007 | Loading state — projects.list pending | shows loading skeleton or spinner; table not yet rendered |
| LIST-008 | Error state — projects.list rejects | shows inline error banner; user can click Retry which calls refresh |

### Add Project view (ADD-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| ADD-001 | Renders 4 numbered FormSection cards in order | Sections 1, 2, 3, 4 visible by data-testid |
| ADD-002 | Submit empty form → inline errors per required field | At least 4 errors visible (name, repo.localPath, repo.baseBranch, tickets.query, etc.); `secrets.set` and `projects.create` NOT called |
| ADD-003 | Repo path "relative/path" → NOT_ABSOLUTE error inline on that field | error visible; submit blocked |
| ADD-004 | Branch format without `{ticketKey}` or `{slug}` → INVALID_BRANCH_FORMAT error | inline visible |
| ADD-005 | Mode picker — Interactive selected by default | first card has selected styling/aria |
| ADD-006 | Submit valid form: secrets.set called BEFORE projects.create | Order assertion via mock invocation order |
| ADD-007 | Submit valid form: secrets.set fails → no projects.create call, banner shown | true |
| ADD-008 | Submit valid form: secrets.set ok then projects.create fails → banner shown, dialog stays open, form values preserved | true |
| ADD-009 | Submit valid form: all succeed → onCreated callback fires | true |
| ADD-010 | Test Connection button success → inline pill "Connected as {displayName}" | pill visible |
| ADD-011 | Test Connection button error → inline pill with error code | pill visible with error text |
| ADD-012 | YOLO mode picker selected → workflow.mode === 'yolo' on submit | argument passed to projects.create reflects yolo |

### App-level (APP-XXX) — replaces #1's FE-001/002/003

| ID | Scenario | Expected |
|----|----------|----------|
| APP-001 | Renders AppShell with sidebar + main | Both visible |
| APP-002 | Renders ProjectList by default (view='list') | ProjectList visible |
| APP-003 | After clicking a row Open button, view switches to detail placeholder | DetailPlaceholder text visible |
| APP-004 | DetailPlaceholder Back button returns to list view | ProjectList visible again |
| APP-005 | Renders without crashing when `window.api` is undefined (regression on #1's FE-003 spirit) | true |
| APP-006 | Sidebar shows e-frank product name | text visible |

## E2E (Playwright) — None in this PR
Real Electron-driven Playwright is deferred to a follow-up issue. The placeholder spec from #1 keeps passing as a runner sanity check.

## Test Status
- [x] TOKEN-001: PASS (2 tests)
- [x] CMP-BTN-001..003 / CMP-BDG-001..002 / CMP-TGL-001..002: PASS (7 tests across 3 files)
- [x] LIST-001..008: PASS (8 tests)
- [x] ADD-001..012: PASS (12 tests)
- [x] APP-001..006: PASS (6 tests)
- [x] Total project: **302/302 unit tests pass** (was 271/271 after #4; +31 new + 4 changed APP tests replacing #1's FE-001..003)
- [x] `npm run lint`: 0 / 0
- [x] `npm run typecheck`: 0
- [x] `npm run build`: clean — bundle now includes the design-system primitives (renderer 283.11 kB / CSS 27.90 kB)

## Manual verification (developer, after PR)
- [ ] `npm run dev` opens the new UI; sidebar shows e-frank, ProjectList renders
- [ ] First launch (empty `projects.json`) shows the empty state
- [ ] Click `+ New Project` → dialog opens with 4 sections
- [ ] Filling the form correctly and submitting persists a project (verify by re-launch — the project should still be there)
- [ ] (Optional, with real Jira) Test Connection button works
