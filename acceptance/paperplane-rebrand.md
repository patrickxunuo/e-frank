# Paperplane Rebrand — Brand Assets + Product Rename + UserData Migration

## Description (client-readable)
Bundled rebrand on `feat/GH-51-paperplane-rebrand-and-assets`. Three lanes that ship together:
1. **Brand assets wired in.** Replace placeholder `IconLogo` with the two-tone paperplane glyph; render the horizontal lockup (theme-aware, dark + light wordmark variants) in the sidebar; add a `<RunStatusFigure>` to the ExecutionView header that animates a Lottie while the run is in flight and swaps to a tinted static glyph on terminal status.
2. **Product renamed to Paperplane.** `electron-builder` `productName` and `appId`, BrowserWindow `title`, `<title>` in `index.html`, `package.json` `description`, README + prd.md, and every user-visible string sweep flip from `e-frank` / "AI Runner" to `Paperplane`. The repo + npm `name` stay `e-frank` (intentional divergence — documented).
3. **UserData migration.** A new `migrate-userdata` module runs once at boot, before any store reads, and copies the legacy `%APPDATA%\e-frank\` (Windows) / `~/Library/Application Support/e-frank/` (macOS) tree into the new Paperplane userData dir on first launch after the rename. Idempotent. Doesn't delete the legacy dir. Tolerates partial failure.

## Adaptation Note
- Renderer additions match the existing CSS-Modules + design-token style.
- Lottie playback is the brand's defining motion signal, so we adopt `lottie-react` (and its peer `lottie-web`). The component honors `prefers-reduced-motion: reduce` by rendering the static glyph instead.
- The migration is main-process Node code; tested with Vitest using a temp dir, no Electron mock — `app.getPath` is injected.

## Interface Contract

### Tech Stack
- React 18 strict TS, CSS Modules, design tokens (no new theming primitives).
- New runtime deps: `lottie-react` and its peer `lottie-web`. No other new deps.
- Migration module is plain Node: `fs/promises`, `path`. No third-party.

### File Structure

```
acceptance/
└── paperplane-rebrand.md                                  # NEW (this file)

src/
├── main/
│   ├── index.ts                                            # MODIFY — title 'e-frank' → 'Paperplane'; call migrateUserData() before initStores()
│   └── modules/
│       └── migrate-userdata.ts                             # NEW — one-shot legacy-userData copy
├── renderer/
│   ├── index.html                                          # MODIFY — <title> → Paperplane
│   ├── components/
│   │   ├── icons.tsx                                       # MODIFY — IconLogo body → paperplane two-tone glyph
│   │   ├── Sidebar.tsx                                     # MODIFY — render PaperplaneLockup + drop separate name/tag
│   │   ├── Sidebar.module.css                              # MODIFY — lockup layout
│   │   ├── RunStatusFigure.tsx                             # NEW — Lottie/static figure driven by run.status
│   │   └── RunStatusFigure.module.css                      # NEW
│   └── views/
│       ├── ExecutionView.tsx                               # MODIFY — render <RunStatusFigure> in title row
│       ├── ExecutionView.module.css                        # MODIFY — minor spacing for the figure
│       ├── Connections.tsx                                 # MODIFY — empty-state copy: e-frank → Paperplane
│       └── ProjectList.tsx                                 # MODIFY — empty-state copy: e-frank → Paperplane

electron-builder.yml                                        # MODIFY — productName + appId
package.json                                                # MODIFY — description; +lottie-react, +lottie-web
README.md                                                   # MODIFY — header + tagline; document repo/product divergence
prd.md                                                      # MODIFY — single line documenting product = Paperplane / repo = e-frank

tests/unit/
├── App.test.tsx                                            # MODIFY — APP-006 expectation flip
├── views-connections.test.tsx                              # MODIFY — copy-assert flip
├── components-sidebar-lockup.test.tsx                      # NEW — testid app-logo + lockup renders
├── components-run-status-figure.test.tsx                   # NEW — figure swap by run.status + reduced-motion fallback
└── migrate-userdata.test.ts                                # NEW — copy / idempotent / partial-failure
```

## A. Brand assets

### A.1 `IconLogo` swap (`src/renderer/components/icons.tsx`)
- Replace the body of `IconLogo` so it renders the two `<polygon>` elements from `paperplane-icon.svg` inside a `viewBox="0 0 32 32"` SVG.
- Preserve the `size` prop (default 22). Scale via `width={size} height={size}`.
- Hard-coded fills: `#5b8dff` (body) and `#2c4a99` (shadow). Brand colors are intentionally invariant across themes (the lockup wordmark is the part that flips).
- `aria-hidden="true"`. No stroke.
- Keep the named export — call sites don't change.

### A.2 Sidebar lockup (`src/renderer/components/Sidebar.tsx`)
- Replace the `<span class="mark"><IconLogo /></span><div class="wordmark">…</div>` block with a single `<PaperplaneLockup />` component (defined in the same file or co-located).
- Lockup renders the inline horizontal SVG (glyph + wordmark): two `<polygon>` glyphs with hard-coded hex fills, plus a `<text>` element using `fill="currentColor"`. The CSS class on the SVG sets `color: var(--text-primary)` so theme switches propagate without `useTheme()` in this component.
- Add `data-testid="app-logo"` on the lockup root SVG.
- Drop the `data-testid="sidebar-product-name"` element (the wordmark is part of the lockup now).
- Keep `Sidebar.tag` ("Ticket → PR") visible BENEATH the lockup as a small caption, OR remove if it crowds the lockup. We KEEP it (it's a useful brand-affordance subtitle) but render it below the lockup, not beside it.

### A.3 Sidebar CSS (`src/renderer/components/Sidebar.module.css`)
- `.brand` becomes a vertical flex (`flex-direction: column`, `align-items: flex-start`, `gap: 4px`).
- New `.lockup` class: `height: 24px; width: auto; color: var(--text-primary)`.
- Drop `.mark` and the linear-gradient background — the new lockup IS the mark.
- Keep `.tag` for the subtitle.

### A.4 `<RunStatusFigure>` (`src/renderer/components/RunStatusFigure.tsx`)
Props: `{ status: RunStatus; state: RunState; size?: number }`.

Rendering rules:
- If `status === 'pending' || status === 'running'` (regardless of whether `state === 'awaitingApproval'`): render the Lottie. The figure is "in flight" until the pipeline settles.
- If `status === 'done'`: render the static glyph in default brand colors.
- If `status === 'failed'`: render the static glyph with the body fill replaced by `var(--danger)` (keep shadow as `var(--danger-deep)` if defined, else fall back to a darker hex).
- If `status === 'cancelled'`: render the static glyph with both fills replaced by `var(--text-tertiary)` (muted).

Reduced-motion fallback:
- If `window.matchMedia('(prefers-reduced-motion: reduce)').matches` is true at first render, render the live status as the default static glyph (in-flight surrogate). Subscribe to the media query so it picks up runtime changes via the `change` event.

Testids:
- Root element: `data-testid="run-status-figure"`. Add `data-status={status}` on the root for diagnostics.
- The Lottie wrapper: `data-testid="run-status-figure-lottie"`.
- The static SVG wrapper: `data-testid="run-status-figure-static"`.

Default size: 60px (within the 60-80px range from the ticket).

### A.5 ExecutionView wiring (`src/renderer/views/ExecutionView.tsx`)
- Render `<RunStatusFigure status={ready.status} state={ready.state} />` inside `.titleBlock` to the LEFT of `.titleRow` (or as the first child of a new `.titleRowWithFigure` wrapper). The simplest fit: change `.titleBlock` to a horizontal flex with the figure on the left and the existing title/subtitle on the right.
- ExecutionView CSS: add a small `.runFigure` class with `flex: 0 0 auto`. Update `.titleBlock` layout to `display: flex; align-items: center; gap: var(--space-3)`.

## B. Product rename to Paperplane

### B.1 `electron-builder.yml`
- `appId: tech.emonster.paperplane`
- `productName: Paperplane`
- All other fields unchanged.

### B.2 `package.json`
- `description: "Desktop AI Ticket → PR Automation. Paperplane converts Jira/GitHub tickets into pull requests via Claude Code with optional human approval."`
- Add `dependencies`:
  - `lottie-react: ^2.4.0`
  - `lottie-web: ^5.12.2`
- Keep `name: e-frank` (npm-internal). Don't touch `author` or `private`.

### B.3 `src/main/index.ts`
- BrowserWindow `title: 'Paperplane'` (was `'e-frank'`).
- Call `migrateUserData()` BEFORE `await initStores();` inside `app.whenReady().then(...)`.

### B.4 `src/renderer/index.html`
- `<title>Paperplane</title>`.

### B.5 User-visible string sweep
- `src/renderer/views/ProjectList.tsx` empty-state description: `… and let Paperplane turn tickets into pull requests.`
- `src/renderer/views/Connections.tsx` empty-state description: `… store the credentials Paperplane uses to fetch tickets and open PRs (Jira API tokens, GitHub PATs, etc.).`
- `tests/unit/App.test.tsx` APP-006: assert `/paperplane/i` instead of `/e-frank/i`.
- `tests/unit/views-connections.test.tsx` VIEW-CONN-002: update the expected description regex/string to `Paperplane`.

### B.6 README + prd
- `README.md`: rename header to `# Paperplane (repo: e-frank)` (or keep `# Paperplane` with a note line: "Repo and npm package name remain `e-frank` for now."). Update the tagline body to use Paperplane.
- `prd.md`: prepend a single-line callout near the top explaining product name = Paperplane, repo = e-frank.

## C. UserData migration

### C.1 `src/main/modules/migrate-userdata.ts`

Exported function signature:
```ts
export interface MigrateUserDataDeps {
  /** Resolves to the new userData path (where electron will store data given the new productName). */
  newUserDataDir: string;
  /** Resolves to the legacy e-frank userData path. Computed as path.join(app.getPath('appData'), 'e-frank'). */
  legacyUserDataDir: string;
}

export type MigrationOutcome =
  | { kind: 'no-legacy' }              // legacy dir doesn't exist — first install
  | { kind: 'already-migrated' }       // migration marker already in new dir
  | { kind: 'migrated'; copied: number; skipped: number; errors: string[] } // copied, with optional partial-failure log
  | { kind: 'failed'; error: string }; // catastrophic — couldn't even create the new dir; logged + non-fatal

export async function migrateUserData(deps: MigrateUserDataDeps): Promise<MigrationOutcome>;
```

Behavior:
1. If `legacyUserDataDir` does NOT exist → return `{ kind: 'no-legacy' }`. (Fresh install.)
2. Ensure `newUserDataDir` exists (`fs.mkdir(newUserDataDir, { recursive: true })`). If that fails → return `{ kind: 'failed', error }`.
3. If `path.join(newUserDataDir, 'migrated-from-efrank.json')` exists → return `{ kind: 'already-migrated' }`. (Idempotent.)
4. Otherwise, recursively copy every file under `legacyUserDataDir` into `newUserDataDir` UNLESS the file already exists at the destination (resume-from-partial-migration safety). Use `fs.cp` with `force: false, recursive: true` if available; otherwise hand-walk the tree.
5. Write `migrated-from-efrank.json` with `{ migratedAt: <ISO timestamp>, source: legacyUserDataDir, counts: { copied, skipped, errors } }`.
6. Append a human-readable summary to `migration.log` in the new dir (one block per migration attempt — not overwriting prior runs).
7. NEVER delete the legacy dir.
8. Per-file errors → record in the `errors[]` array, do NOT throw. Return `{ kind: 'migrated', ... }` even on partial failure.

The function must be safe to await from `app.whenReady()` BEFORE `initStores()`.

### C.2 Main wiring (`src/main/index.ts`)

```ts
app.whenReady().then(async () => {
  const newUserDataDir = app.getPath('userData');
  const legacyUserDataDir = join(app.getPath('appData'), 'e-frank');
  const outcome = await migrateUserData({ newUserDataDir, legacyUserDataDir });
  console.log('[migrate-userdata]', outcome);
  await initStores();
  // ... rest unchanged
});
```

Migration log line surfaces the outcome to stdout for diagnostic visibility. Failures don't throw — boot continues with whatever copied successfully.

## Acceptance

### Brand assets wired in
- [ ] `IconLogo` body matches `paperplane-icon.svg` exactly (two polygons with `#5b8dff` / `#2c4a99` fills).
- [ ] Sidebar header renders the horizontal lockup. `data-testid="app-logo"` is present on the lockup SVG.
- [ ] Sidebar lockup wordmark color follows `--text-primary` (verified: changing `data-theme` flips the rendered fill via `currentColor`).
- [ ] ExecutionView header shows `<RunStatusFigure>` to the LEFT of the title block.
  - Status `pending` / `running` (any state including `awaitingApproval`) → `data-testid="run-status-figure-lottie"` is present.
  - Status `done` → `data-testid="run-status-figure-static"` is present, default colors.
  - Status `failed` → static, `--danger` body fill.
  - Status `cancelled` → static, muted `--text-tertiary` fill.
- [ ] `prefers-reduced-motion: reduce` → static figure renders in place of the Lottie even for live runs (verified by mocking `window.matchMedia`).
- [ ] testids `run-status-figure`, `run-status-figure-lottie`, `run-status-figure-static`, `app-logo` are all present + queryable.
- [ ] No regressions in existing logo call sites (`IconLogo` still imported by Sidebar test fixtures; size prop still respected).

### Product renamed to Paperplane
- [ ] `electron-builder.yml`: `productName: Paperplane`, `appId: tech.emonster.paperplane`.
- [ ] `package.json` `description` mentions Paperplane.
- [ ] `src/main/index.ts` BrowserWindow `title: 'Paperplane'`.
- [ ] `src/renderer/index.html` `<title>Paperplane</title>`.
- [ ] No literal `e-frank` / `E-Frank` / `AI Runner` strings remain in user-visible renderer copy. (Code identifiers, IPC channels, npm `name` are EXEMPT.)
- [ ] README + prd document the rename + repo divergence.

### UserData migration safe
- [ ] `migrateUserData` returns `{ kind: 'no-legacy' }` when the legacy dir is absent. Fresh install scenario.
- [ ] When new dir is empty + legacy has files: every legacy file under root + nested dirs is copied; `migrated-from-efrank.json` exists in the new dir.
- [ ] When new dir already has `migrated-from-efrank.json`: function is a no-op and returns `{ kind: 'already-migrated' }`.
- [ ] Files that already exist in the new dir are skipped (not overwritten); `skipped` counter reflects them.
- [ ] Per-file copy failures get recorded in `errors[]` but DO NOT throw; outcome is still `{ kind: 'migrated', ... }`.
- [ ] `migration.log` is appended (not overwritten) when the function runs.
- [ ] Legacy dir contents are present after migration (verifying the function never deletes the source).
- [ ] Migration is awaited BEFORE `initStores()` in `app.whenReady` (verified by code review of `src/main/index.ts`).

### Test coverage
- [ ] Vitest unit suite passes: existing 911 + new tests in `components-run-status-figure.test.tsx`, `components-sidebar-lockup.test.tsx`, `migrate-userdata.test.ts`. App + connections copy-assertion tests updated.

## Out of scope
- Renaming the GitHub repo or npm package `name`.
- Auto-deleting the legacy userData dir.
- Empty-state Lottie on the Projects page (the "nice to have" — punt to a follow-up if needed).
- Internal IPC channel renames or code-only `e-frank` references.
- Cross-OS migration of paths set with absolute strings inside copied JSON (we copy bytes verbatim; if a stored path embedded the legacy dirname inside a value, that's a future cleanup).
