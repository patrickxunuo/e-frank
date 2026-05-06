# UI Polish — Theme + Dropdown + Focus

## Description (client-readable)
Bundled design-system refinements onto `feat/connection-model`. Three deliverables:
1. **Light + dark theme** with a binary toggle in the sidebar. Hard-defaults to dark on first launch. Persists in `localStorage`.
2. **Reusable `<Dropdown>` component** replacing the current `<Select>`. Custom-styled trigger + popover, but renders a hidden native `<select>` underneath so existing `fireEvent.change` tests and form semantics still work.
3. **Single-edge focus indicator** on inputs/textareas/dropdowns — solid `--accent` border + 3px `--accent-soft` halo (no double concentric ring).

## Adaptation Note
This is a renderer-only feature, no main-process work. Tests use jsdom + Testing Library + Vitest, same as every prior PR. No Electron-driven Playwright.

## Interface Contract

### Tech Stack (locked)
- React 18 strict TS, CSS Modules, hand-rolled tokens
- No new runtime deps

### File Structure (exact)

```
src/
├── renderer/
│   ├── components/
│   │   ├── Dropdown.tsx                         # NEW
│   │   ├── Dropdown.module.css                  # NEW
│   │   ├── Input.module.css                     # MODIFY — single-edge focus
│   │   ├── Sidebar.tsx                          # MODIFY — mount ThemeToggle above user card
│   │   ├── Sidebar.module.css                   # MODIFY — token any hardcoded colors
│   │   ├── ThemeToggle.tsx                      # NEW
│   │   ├── ThemeToggle.module.css               # NEW
│   │   ├── icons.tsx                            # MODIFY — add IconSun, IconMoon, IconChevronDown
│   │   └── Select.tsx                           # DELETE — no consumers after migration
│   ├── state/
│   │   └── theme.ts                             # NEW — useTheme()
│   ├── styles/
│   │   └── tokens.css                           # MODIFY — light + dark scopes
│   ├── views/
│   │   └── AddProject.tsx                       # MODIFY — Select → Dropdown
│   └── components/
│       └── AddConnectionDialog.tsx              # MODIFY — Select → Dropdown

src/renderer/index.html                          # MODIFY — set initial data-theme="dark" to prevent flash

tests/unit/
├── components-dropdown.test.tsx                 # NEW
├── components-theme-toggle.test.tsx             # NEW
├── state-theme.test.tsx                         # NEW
└── tokens.test.ts                               # MODIFY — assert both theme scopes
```

## A. Theme System

### `tokens.css` restructure (exact)

Top of the file:
```css
/*
 * Design tokens. Two scopes:
 *   :root[data-theme='dark']   — dark palette (refined from the prior single :root set)
 *   :root[data-theme='light']  — light palette
 *
 * App.tsx writes data-theme to <html> on mount via useTheme(). The hard
 * default for first-launch users is 'dark' (set in index.html so the
 * pre-React paint doesn't flash light).
 */
```

Then declare BOTH scopes. Tokens that exist in BOTH scopes (mandated by `tokens.test.ts`):

```
--bg-app, --bg-sidebar, --bg-card, --bg-card-elevated, --bg-input,
--border-subtle, --border-default, --border-emphasis,
--accent, --accent-hover, --accent-press, --accent-deep, --accent-soft, --accent-border,
--success, --success-soft, --warning, --warning-soft, --danger, --danger-soft,
--text-primary, --text-secondary, --text-tertiary, --text-on-accent,
--shadow-sm, --shadow-md, --shadow-glow-accent
```

Layout/typography/motion tokens are theme-agnostic and stay declared once at `:root` (or duplicated harmlessly):

```
--space-1..8, --radius-sm/md/lg/pill, --ease-out, --ease-in-out, --duration-fast, --duration-base,
--font-display, --font-body, --font-mono
```

### Dark palette (refined)

Most tokens carry over. Bumps:
- `--text-tertiary: #6b7180` (was `#5b606b`) — bumps contrast against `--bg-app` from ~3.2:1 to ~4.6:1, clears WCAG AA for labels.
- `--shadow-glow-accent: 0 0 0 2px rgba(77, 124, 255, 0.55), 0 8px 24px rgba(77, 124, 255, 0.22)` — slightly stronger ring + halo so button focus is unambiguous.

Keep:
- `--bg-app: #0e0f13`, `--bg-sidebar: #14161c`, `--bg-card: #1a1d24`, `--bg-card-elevated: #232732`, `--bg-input: #14161c`
- `--text-primary: #ecedf1`, `--text-secondary: #8a8f99`, `--text-on-accent: #ffffff`
- `--accent: #4d7cff`, `--accent-hover: #6b91ff`, `--accent-press: #3a64da`, `--accent-deep: #2c4ea0`, `--accent-soft: rgba(77, 124, 255, 0.16)`, `--accent-border: rgba(77, 124, 255, 0.32)`
- `--success: #4ad98a`, `--success-soft: rgba(74, 217, 138, 0.14)`
- `--warning: #f0b95c`, `--warning-soft: rgba(240, 185, 92, 0.14)`
- `--danger: #f06f6f`, `--danger-soft: rgba(240, 111, 111, 0.14)`
- `--border-subtle: rgba(255, 255, 255, 0.06)`, `--border-default: rgba(255, 255, 255, 0.10)`, `--border-emphasis: rgba(255, 255, 255, 0.18)`
- `--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4)`, `--shadow-md: 0 6px 18px rgba(0, 0, 0, 0.45)`

Add `color-scheme: dark` inside the dark scope.
Bump `--accent-soft` opacity from 0.12 → 0.16 so the new focus halo reads on busy backgrounds.

### Light palette (new)

```css
:root[data-theme='light'] {
  --bg-app:               #ffffff;
  --bg-sidebar:           #f5f6f8;
  --bg-card:              #ffffff;
  --bg-card-elevated:     #ffffff;
  --bg-input:             #ffffff;

  --border-subtle:        rgba(15, 17, 23, 0.06);
  --border-default:       rgba(15, 17, 23, 0.12);
  --border-emphasis:      rgba(15, 17, 23, 0.22);

  --accent:               #3a6ae8;     /* slightly deeper than #4d7cff so it carries weight on white */
  --accent-hover:         #2c54bf;
  --accent-press:         #21449d;
  --accent-deep:          #182f6c;
  --accent-soft:          rgba(58, 106, 232, 0.10);
  --accent-border:        rgba(58, 106, 232, 0.30);

  --success:              #138a4f;
  --success-soft:         rgba(19, 138, 79, 0.10);
  --warning:              #b67514;
  --warning-soft:         rgba(182, 117, 20, 0.12);
  --danger:               #c83232;
  --danger-soft:          rgba(200, 50, 50, 0.10);

  --text-primary:         #0e0f13;
  --text-secondary:       #4a4f59;
  --text-tertiary:        #8a8f99;
  --text-on-accent:       #ffffff;

  --shadow-sm:            0 1px 2px rgba(15, 17, 23, 0.06);
  --shadow-md:            0 8px 24px rgba(15, 17, 23, 0.08);
  --shadow-glow-accent:   0 0 0 2px rgba(58, 106, 232, 0.40), 0 8px 24px rgba(58, 106, 232, 0.18);

  color-scheme: light;
}
```

### `useTheme()` hook

`src/renderer/state/theme.ts`:

```ts
export type ThemePreference = 'light' | 'dark';

const STORAGE_KEY = 'ef.theme';

export interface UseThemeResult {
  theme: ThemePreference;
  setTheme: (next: ThemePreference) => void;
  toggle: () => void;
}

export function useTheme(): UseThemeResult;
```

Behaviour:
- On first render, read `localStorage.getItem('ef.theme')`. If `'light'` or `'dark'`, use it. Otherwise default to `'dark'`.
- Write the resolved value to `<html data-theme="...">` on every change (via `useEffect`).
- Persist any change to `localStorage`.
- `toggle()` flips between light and dark.
- Handles `localStorage` unavailable (tests, sandboxed envs) gracefully — falls through to in-memory state.

### `<ThemeToggle>`

`src/renderer/components/ThemeToggle.tsx`:

```ts
export interface ThemeToggleProps {
  'data-testid'?: string;
}
```

- Renders a single `<button>` with the current theme's icon: `<IconMoon>` when `theme === 'dark'`, `<IconSun>` when `theme === 'light'`.
- aria-label: `"Switch to light theme"` / `"Switch to dark theme"` matching the next state.
- testid default: `'theme-toggle'`.
- onClick → `toggle()`.
- Styled like a `<Button variant="icon" size="sm">` — but bring its own thin CSS module for placement chrome.

### Sidebar mount

In `Sidebar.tsx`, render `<ThemeToggle />` **above** the user card (inside the sidebar root, between `.spacer` and `.user`). Fits the existing layout — no new prop, the component is self-contained.

### Initial paint guard

`src/renderer/index.html`:
- Add `data-theme="dark"` to the `<html>` element at build time, **plus** a tiny inline script in `<head>` that reads localStorage and overrides if the user previously chose `'light'`. Prevents a light-flash on cold start when the user's last preference was dark, and dark-flash if the user chose light.

```html
<html lang="en" data-theme="dark">
<head>
  <script>
    (function () {
      try {
        var t = localStorage.getItem('ef.theme');
        if (t === 'light' || t === 'dark') {
          document.documentElement.setAttribute('data-theme', t);
        }
      } catch (e) {}
    })();
  </script>
  ...
</head>
```

### CSS-module token audit

Every CSS module under `src/renderer/{components,views}/` must use `var(--token)` for color/border/shadow values. Sweep these specifically (most are already clean):
- `Sidebar.module.css` — verify gradient backgrounds use tokens (the brand mark may have a hardcoded gradient).
- `ApprovalPanel.module.css` — already clean after the prior PR's `--accent-soft` / `--accent-border` fix.
- `AddConnectionDialog.module.css` — verify.
- `Connections.module.css` — verify.
- `ExecutionView.module.css`, `ExecutionLog.module.css`, `PromptInput.module.css` — verify.
- `Dialog.module.css` — verify backdrop/overlay shades use tokens.
- All other component modules — sweep for any `#[0-9a-fA-F]` literal.

Where a hardcoded value exists, replace with the closest token. If no good token exists, add one to `tokens.css` (in BOTH scopes).

## B. `<Dropdown>`

### Design pattern

Hybrid approach for backwards-compat with existing `fireEvent.change` tests:

- A **hidden native `<select>`** mirrors the value, holds the `data-testid`, and fires `onChange` on changes (so existing tests pass without rewrites).
- A **custom-styled trigger button** displays the selected option's label + a chevron.
- A **popover** renders below the trigger when open, with each option as a `<li>` button.
- Option click → updates the hidden select's value (which triggers onChange) AND closes the popover.
- Click-outside, Escape → close.
- Arrow Up/Down on trigger → navigate options (open if closed). Enter → select highlighted.

### API

`src/renderer/components/Dropdown.tsx`:

```ts
export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<DropdownOption>;
  /** Placeholder shown when value is empty / not in options. */
  placeholder?: string;
  /** Goes on the hidden native <select> so existing fireEvent.change tests keep working. */
  'data-testid'?: string;
  name?: string;
}
```

Render structure:

```
<div class="field">
  <label>...</label>
  <div class="shell" [data-error] [data-disabled] [data-open]>
    <button type="button" class="trigger" data-testid="{testid}-trigger">
      <span class="value">{selectedLabel ?? placeholder}</span>
      <span class="chevron"><IconChevronDown /></span>
    </button>
    <select hidden value={value} onChange={...} data-testid={testid} name={name} aria-hidden="true" tabindex="-1">
      {options.map(o => <option value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  </div>
  {open && (
    <ul class="menu" role="listbox" data-testid="{testid}-menu">
      {options.map((o, i) => (
        <li key={o.value}>
          <button type="button" class="option" data-disabled={o.disabled} data-active={value === o.value} data-testid="{testid}-option-{o.value}" onClick={...}>
            {o.label}
          </button>
        </li>
      ))}
    </ul>
  )}
  <span class="message">...</span>
</div>
```

### Migration

`src/renderer/views/AddProject.tsx`:
- Replace the `<Select>` for `repoType` with `<Dropdown>` using `options=[{value:'github', label:'GitHub'}, {value:'bitbucket', label:'Bitbucket'}]`. Preserve `data-testid="field-repo-type"` on the hidden select.
- Replace the `<Select>` for `ticketSource` with `<Dropdown>` using `options=[{value:'jira', label:'Jira'}]`. Preserve `data-testid="field-ticket-source"`.
- Update the `onChange` from `(e) => set('repoType', e.target.value as RepoType)` to `(value) => set('repoType', value as RepoType)`.

`src/renderer/components/AddConnectionDialog.tsx`:
- Replace the `<Select>` for `provider` with `<Dropdown>` using `options=[{value:'github', label:'GitHub'}, {value:'jira', label:'Jira'}, {value:'bitbucket', label:'Bitbucket (coming soon)', disabled:true}]`. Preserve `data-testid="connection-provider-select"`.
- Update the `onChange` similarly.

After both migrations, **delete** `src/renderer/components/Select.tsx`. Verify no other consumers exist (`grep -r "from.*Select" src/`).

## C. Focus refactor

`src/renderer/components/Input.module.css`:

```css
/* before */
.shell:focus-within {
  border-color: var(--accent);
  box-shadow: var(--shadow-glow-accent);
}

/* after */
.shell:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.shell.error:focus-within {
  box-shadow: 0 0 0 3px var(--danger-soft);
}
```

Apply the same single-edge pattern in:
- `Dropdown.module.css` (`.shell[data-open]` and `.shell:focus-within`)
- Any other module currently using `var(--shadow-glow-accent)` against an element that already has a border. Buttons keep `--shadow-glow-accent` (no border, the ring acts as the visual border).

## Business Rules

1. **Theme persists** across reloads via `localStorage`. First launch (no stored value) defaults to dark.
2. **No system-preference detection** in this PR. Binary toggle only.
3. **Hidden `<select>` carries the testid** for Dropdown so existing tests don't break. The trigger and menu items get suffixed testids (`-trigger`, `-menu`, `-option-{value}`).
4. **Disabled options** are not selectable but are visible in the menu (used for "Bitbucket (coming soon)").
5. **Inputs/textarea/Dropdown shells** use `border + 3px halo` focus, NOT `--shadow-glow-accent`. Buttons keep `--shadow-glow-accent`.
6. **Both themes declare every required token.** `tokens.test.ts` enforces this.
7. **All interactive elements** carry `data-testid` (sidebar `theme-toggle`, dropdown trigger/menu/options).

## API Acceptance Tests

### `useTheme` (THEME-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| THEME-001 | First render with no localStorage value → returns `'dark'` and writes `data-theme="dark"` to `<html>` | true |
| THEME-002 | localStorage has `'light'` → returns `'light'` and writes attribute | true |
| THEME-003 | localStorage has invalid value (`'system'`, garbage) → returns `'dark'` | true |
| THEME-004 | `setTheme('light')` writes both DOM attribute and localStorage | true |
| THEME-005 | `toggle()` from dark → light updates state, attribute, storage | true |
| THEME-006 | `toggle()` from light → dark updates state, attribute, storage | true |
| THEME-007 | localStorage throws on read → falls back to `'dark'` (no crash) | true |
| THEME-008 | localStorage throws on write → state still updates (no crash) | true |

### `<ThemeToggle>` (CMP-THEME-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-THEME-001 | Renders moon icon when theme is dark | true |
| CMP-THEME-002 | Renders sun icon when theme is light | true |
| CMP-THEME-003 | aria-label reflects the *next* state ("Switch to light theme" when dark) | true |
| CMP-THEME-004 | Click toggles theme | localStorage updated + html attribute flipped |
| CMP-THEME-005 | data-testid defaults to `theme-toggle` and is overridable | true |

### `<Dropdown>` (CMP-DROPDOWN-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-DROPDOWN-001 | Hidden `<select>` renders with the `data-testid` from props | true |
| CMP-DROPDOWN-002 | `fireEvent.change` on the hidden select fires `onChange(value)` | parity with old Select tests |
| CMP-DROPDOWN-003 | Trigger displays the label of the currently-selected option | true |
| CMP-DROPDOWN-004 | Trigger click opens the menu (testid `{testid}-menu`) | true |
| CMP-DROPDOWN-005 | Click an option calls `onChange(value)` and closes the menu | true |
| CMP-DROPDOWN-006 | Disabled option does NOT call `onChange` on click and does not close the menu | true |
| CMP-DROPDOWN-007 | Click outside closes the menu | true |
| CMP-DROPDOWN-008 | Escape key on the trigger closes the menu | true |
| CMP-DROPDOWN-009 | Arrow Down on closed trigger opens the menu | true |
| CMP-DROPDOWN-010 | `disabled` prop disables both trigger and hidden select | true |
| CMP-DROPDOWN-011 | `error` prop renders the error message and applies error styling | true |
| CMP-DROPDOWN-012 | Trigger shows placeholder when no option matches `value` | true |

### Tokens (TOKEN-XXX, REVISED)

| ID | Scenario | Expected |
|----|----------|----------|
| TOKEN-001 | All required tokens declared at `:root[data-theme='dark']` | true |
| TOKEN-002 | All required tokens declared at `:root[data-theme='light']` | true |
| TOKEN-003 | `:root[data-theme='dark']` has `color-scheme: dark` | true |
| TOKEN-004 | `:root[data-theme='light']` has `color-scheme: light` | true |
| TOKEN-005 | Layout/typography/motion tokens still declared at `:root` | true |

(The pre-existing `TOKEN-001` "tokens declared on :root" test gets reframed: tokens are still declared on `:root[data-theme=...]` selectors which match `:root`. Update the test to assert presence in either scope.)

### Migration regression (REGR-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| REGR-001 | AddProject existing tests for `field-repo-type` still pass via hidden select | true |
| REGR-002 | AddProject existing tests for `field-ticket-source` still pass | true |
| REGR-003 | AddConnectionDialog existing tests for `connection-provider-select` still pass | true |

## Manual verification (after PR)
- [ ] Cold-start the app → loads in dark theme
- [ ] Click theme toggle in sidebar → switches to light
- [ ] Restart the app → still in light
- [ ] Click toggle → switches to dark
- [ ] Open Add Project / Add Connection → dropdowns open, options selectable, look themed
- [ ] Focus an input → solid border + soft halo (no double ring)
- [ ] Tab through a form → focus indicator clearly visible in both themes

## Test Status
- [ ] THEME-001..008
- [ ] CMP-THEME-001..005
- [ ] CMP-DROPDOWN-001..012
- [ ] TOKEN-001..005
- [ ] REGR-001..003
- [ ] All prior tests still pass
- [ ] `npm run lint`: 0
- [ ] `npm run typecheck`: 0
- [ ] `npm run build`: clean
