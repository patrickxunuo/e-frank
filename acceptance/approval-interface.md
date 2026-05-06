# Approval Interface — Acceptance Criteria

## Description (client-readable)
The right pane of the ExecutionView. Renders the Approval Panel when Claude pauses on a checkpoint and the runner has populated `Run.pendingApproval` (interactive mode only — yolo auto-approves and never enters this state). The panel shows the implementation plan, files to be modified, and a syntax-highlighted code-diff preview. The action bar has Approve, Edit / Modify, and Reject buttons; Modify reveals a `<PromptInput>` pre-filled with the plan and submits via `runs.modify`. When `pendingApproval === null`, the right pane is hidden and the log reclaims full width.

## Adaptation Note
This is a **renderer-only UI feature**. The marker contract, IPC channels, and `Run.pendingApproval` are already shipped (#7). The host page (#8 ExecutionView), shared `<PromptInput>`, and design tokens (#5) are also already shipped. No main-process changes; no new runtime dependencies.

## Interface Contract

### Tech Stack (locked, inherited from #1-#8)
- React 18 + TypeScript strict
- CSS Modules + tokens from #5 (General Sans, JetBrains Mono, accent/danger/success colors, radii, spacing)
- No new runtime deps — hand-rolled syntax tokenizer for TS/JS/Python/Go

### File Structure (exact)

```
src/
├── renderer/
│   ├── components/
│   │   ├── ApprovalPanel.tsx                  # NEW
│   │   ├── ApprovalPanel.module.css           # NEW
│   │   ├── CodeDiff.tsx                       # NEW
│   │   ├── CodeDiff.module.css                # NEW
│   │   └── syntax.ts                          # NEW — language tokenizer for diff lines
│   └── views/
│       ├── ExecutionView.tsx                  # MODIFY — replace placeholder block with <ApprovalPanel> branch
│       └── ExecutionView.module.css           # MODIFY — drop placeholder rules; collapse body grid when no panel

memory-bank/
└── checkpoint-protocol.md                     # NEW — pointer to systemPatterns.md's locked marker contract

tests/unit/
├── components-approval-panel.test.tsx         # NEW
├── components-code-diff.test.tsx              # NEW
├── components-syntax.test.ts                  # NEW
└── views-execution-view.test.tsx              # MODIFY — replace placeholder testid checks with approval-panel testid checks
```

### Components

**`<ApprovalPanel>`** — `src/renderer/components/ApprovalPanel.tsx`

```ts
interface ApprovalPanelProps {
  runId: string;
  /** From Run.pendingApproval — guaranteed non-null by the parent. */
  approval: ApprovalRequest;
  /** Whether the run is in a state where actions are still meaningful.
   *  Parent passes false during the transition out of awaitingApproval. */
  disabled?: boolean;
  /**
   * Hook for tests / future telemetry. Resolves true on success.
   * Default implementation calls window.api.runs.{approve|reject|modify}.
   */
  onApprove?: (runId: string) => Promise<boolean>;
  onReject?: (runId: string) => Promise<boolean>;
  onModify?: (runId: string, text: string) => Promise<boolean>;
}
```

Behavior:
- Root container has `data-testid="approval-panel-root"`.
- Sticky header reads "Approval Required" (display font) + subhead "Review and approve the proposed changes." (~14px secondary).
- **Implementation Plan** section renders `approval.plan` as preformatted prose. If `plan` is undefined or empty, the section is hidden.
- **Files to Modify** section renders `approval.filesToModify` as a vertical list. Each item: file-type icon (derived from extension — `.ts`/`.tsx` → TS, `.js`/`.jsx` → JS, `.py` → PY, `.go` → GO, anything else → generic) + the file path in monospace. If the array is empty or undefined, the section is hidden.
- **Code Diff Preview** section renders `approval.diff` via `<CodeDiff>`. If `diff` is undefined or empty, the section is hidden.
- **Action bar** (sticky at top of action region, NOT the page footer): three buttons in this order — Approve (primary, success-green), Edit / Modify (secondary, neutral), Reject (destructive, red).
  - testids: `approve-button`, `modify-button`, `reject-button`.
  - Approve calls `onApprove(runId)` (default: `window.api.runs.approve({ runId })`).
  - Reject calls `onReject(runId)` (default: `window.api.runs.reject({ runId })`).
  - Modify toggles a local `composerOpen` boolean; the action bar buttons remain visible while open (the user can change their mind and Approve directly).
- **Modify composer** (revealed when `composerOpen === true`): a `<PromptInput initialValue={approval.plan ?? ''} sendLabel="Send to AI" />`; on submit calls `onModify(runId, text)`. The composer's `onSubmit` returns a Promise that resolves true on a successful IPC ack. The composer is **not** the page-bottom PromptInput — it lives inside the panel for the modify flow only.
- All three action buttons set `disabled` while `disabled === true` OR while any of the three actions is in flight (`pendingAction !== null`).
- The panel uses the existing `<Button>` design-system component — no ad-hoc button styles.

**`<CodeDiff>`** — `src/renderer/components/CodeDiff.tsx`

```ts
interface CodeDiffProps {
  /** Raw diff string. We assume unified-diff style ('+'/'-'/' ' line prefixes,
   *  optional '@@ ... @@' hunk markers). Anything else falls back to plain
   *  monospace rendering. */
  diff: string;
  /** Optional language hint for syntax tokenization.
   *  Auto-detected from filenames in 'diff --git' / '+++' headers when omitted. */
  language?: 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'go' | 'plain';
  'data-testid'?: string;
}
```

Behavior:
- Renders a `<pre><code>` block with each line wrapped in a `<span>`.
- Each line carries a `data-line-kind` attribute: `'add'` (`+`), `'remove'` (`-`), `'context'` (` `), `'hunk'` (`@@`), or `'meta'` (`diff --git`, `index`, `+++`, `---`, etc.).
- Each line gets a left gutter showing the line number (1-based, monotonic across the rendered diff). Removed lines and added lines each get their own counter; hunk/meta lines have a blank gutter.
- The line text is colorized by tokenizing only the **content** portion (after the `+`/`-`/` ` marker) according to `language`. Tokenization is opt-in — when `language === 'plain'` or unrecognized, lines render as plain text.
- Syntax tokens get classes: `tk-keyword`, `tk-string`, `tk-comment`, `tk-number`, `tk-punct`, `tk-ident`. CSS module styles map these to colors that work on dark theme.
- Falls back gracefully on malformed diffs: non-conforming lines render with `data-line-kind="context"`.
- Test-friendly: the root pre tag carries `data-testid="code-diff"` (overridable via prop).

**Syntax tokenizer** — `src/renderer/components/syntax.ts`

```ts
export type SyntaxLanguage = 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'go' | 'plain';

export interface SyntaxToken {
  kind: 'keyword' | 'string' | 'comment' | 'number' | 'punct' | 'ident' | 'whitespace';
  text: string;
}

/** Detect language from a filename or path. Returns 'plain' when uncertain. */
export function detectLanguage(filename: string | undefined): SyntaxLanguage;

/** Tokenize a single line of source. Comments / strings that span lines are
 *  closed at end-of-line — adequate for diff rendering and avoids cross-line
 *  state. */
export function tokenize(line: string, language: SyntaxLanguage): SyntaxToken[];
```

Tokenizer rules (MVP):
- Keywords per language:
  - **ts/tsx/js/jsx**: `const`, `let`, `var`, `function`, `class`, `extends`, `return`, `if`, `else`, `for`, `while`, `do`, `switch`, `case`, `break`, `continue`, `new`, `this`, `typeof`, `instanceof`, `import`, `from`, `export`, `default`, `async`, `await`, `try`, `catch`, `finally`, `throw`, `void`, `null`, `undefined`, `true`, `false`, `interface`, `type`, `enum`, `as`, `is`, `in`, `of`, `keyof`, `readonly`, `public`, `private`, `protected`, `static`.
  - **py**: `def`, `class`, `return`, `if`, `elif`, `else`, `for`, `while`, `break`, `continue`, `pass`, `import`, `from`, `as`, `try`, `except`, `finally`, `raise`, `with`, `lambda`, `yield`, `global`, `nonlocal`, `True`, `False`, `None`, `and`, `or`, `not`, `is`, `in`.
  - **go**: `func`, `package`, `import`, `var`, `const`, `type`, `struct`, `interface`, `map`, `chan`, `return`, `if`, `else`, `for`, `range`, `switch`, `case`, `default`, `break`, `continue`, `go`, `defer`, `select`, `nil`, `true`, `false`.
- Strings: `"…"`, `'…'`, and (ts/js only) `` `…` `` — treat the whole single-line span as a string token; if the closing quote is missing on this line, the token still ends at end-of-line.
- Comments: `// …` (ts/js/go) and `# …` (py) to end-of-line. Block comments (`/* … */`) on a single line are also recognized.
- Numbers: `\d+(\.\d+)?` (after a non-identifier boundary).
- Identifiers: `[A-Za-z_][A-Za-z0-9_]*` not matching a keyword.
- Punctuation: any single non-identifier, non-whitespace, non-string-delimiter char.
- Whitespace: preserved verbatim as `kind: 'whitespace'` to keep diff alignment intact.

### View — `<ExecutionView>` modifications

In `src/renderer/views/ExecutionView.tsx`:

- Replace the existing `<aside className={styles.rightPane}>` placeholder block.
- Compute `const showApproval = ready.pendingApproval !== null;` once after the `ready = resolution.run` line.
- Right pane render:
  - When `showApproval === true`: render `<aside className={styles.rightPane} aria-label="Approval panel"><ApprovalPanel runId={ready.id} approval={ready.pendingApproval!} disabled={isTerminal(ready)} /></aside>`.
  - When `showApproval === false`: do NOT render the `<aside>` at all.
- Body grid: when no panel, the `.body` container should drop to a single column so `<ExecutionLog>` reclaims full width. Implemented via a `data-has-panel="true|false"` attribute on `.body` and a CSS rule that overrides `grid-template-columns: minmax(0, 1fr)` when the attribute is `false`.
- The page-bottom `<PromptInput>` (`log-prompt-input`) is **unchanged** — it still calls `claude.write`. The Modify composer is a separate `<PromptInput>` instance inside the panel.

### Memory bank doc

`memory-bank/checkpoint-protocol.md` is a thin pointer document:
- Title: "Checkpoint protocol"
- One paragraph saying the marker, payload, and resume contract are documented in `systemPatterns.md`'s "Approval marker format (locked, since #7)" section, that #9's UI consumes the parsed payload via `Run.pendingApproval`, and that any change to the marker requires bumping a marker version (per the systemPatterns rule).
- Add a one-line entry to `memory-bank/index.md` under Topic Files.

## Business Rules

1. **Right pane visibility** — the panel renders if and only if `Run.pendingApproval !== null`. State alone (`awaitingApproval`) is not the gate; the payload is. (Parent never sees `awaitingApproval` without a payload, but defensive coding reads from the payload directly.)
2. **No double-write** — Modify calls `runs.modify`, NOT `claude.write`. The runner writes to stdin synchronously after the deferred resolves.
3. **Empty Modify text is blocked** — `<PromptInput>`'s existing `sendDisabled` rule (trimmed length 0) handles this; no additional gate is needed in the panel.
4. **Action buttons disabled while in flight** — three buttons share a `pendingAction` state to prevent double-fire and racing actions.
5. **`disabled` prop** comes from the parent when the run is terminal (status `done`/`failed`/`cancelled`). Defensive: if the runner already advanced past `awaitingApproval`, the panel will simply unmount (because `pendingApproval` clears), but `disabled` ensures buttons don't fire mid-transition.
6. **Diff syntax highlighter** is hand-rolled — no Prism / Shiki / highlight.js dependency. Languages supported: TS / JS (incl. TSX/JSX) / Python / Go. Anything else falls through to plain rendering.
7. **All interactive elements** carry `data-testid`. The four mandated testids are: `approval-panel-root`, `approve-button`, `modify-button`, `reject-button`. Internal sub-elements (the diff `<pre>`, the modify composer textarea, files-list items) also carry testids per project convention.
8. **No new runtime deps**, no changes to the IPC contract, no main-process changes.
9. **Memory-bank doc** is a thin pointer to `systemPatterns.md`; we do not duplicate the locked contract.

## API Acceptance Tests

### Syntax tokenizer (CMP-SYNTAX-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-SYNTAX-001 | `detectLanguage('foo.ts')` returns `'ts'`; `.tsx` → `'tsx'`; `.js` → `'js'`; `.jsx` → `'jsx'`; `.py` → `'py'`; `.go` → `'go'`; unknown / undefined → `'plain'` | true |
| CMP-SYNTAX-002 | TS keywords tokenize as `kind: 'keyword'` (e.g. `const`, `function`, `interface`) | true |
| CMP-SYNTAX-003 | TS strings tokenize as `kind: 'string'` (single, double, template) | true |
| CMP-SYNTAX-004 | TS line comments `// foo` tokenize as `kind: 'comment'` from `//` to EOL | true |
| CMP-SYNTAX-005 | Python keywords (`def`, `class`, `True`, `None`) tokenize as `keyword` | true |
| CMP-SYNTAX-006 | Python `# comment` tokenizes as `comment` | true |
| CMP-SYNTAX-007 | Go keywords (`func`, `package`, `chan`) tokenize as `keyword` | true |
| CMP-SYNTAX-008 | Numbers tokenize as `kind: 'number'` after a non-identifier boundary | true |
| CMP-SYNTAX-009 | Identifiers tokenize as `ident` (not keyword) | `myVar` → ident |
| CMP-SYNTAX-010 | Whitespace preserved as `kind: 'whitespace'` to keep alignment | tokens reassemble to original line |
| CMP-SYNTAX-011 | `language: 'plain'` returns one whole-line token of kind `ident` (or single `whitespace`) — no keyword colorization | true |
| CMP-SYNTAX-012 | Unterminated string ends at EOL (no cross-line state) | `const s = "abc` → string token |

### `<CodeDiff>` (CMP-CODE-DIFF-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-CODE-DIFF-001 | Lines starting `+` (not `+++`) get `data-line-kind="add"` | true |
| CMP-CODE-DIFF-002 | Lines starting `-` (not `---`) get `data-line-kind="remove"` | true |
| CMP-CODE-DIFF-003 | Lines starting ` ` (space) get `data-line-kind="context"` | true |
| CMP-CODE-DIFF-004 | Lines starting `@@` get `data-line-kind="hunk"` | true |
| CMP-CODE-DIFF-005 | Lines starting `diff --git`, `index `, `+++`, `---` get `data-line-kind="meta"` | true |
| CMP-CODE-DIFF-006 | Add/remove gutters increment independently; hunk/meta lines have blank gutters | true |
| CMP-CODE-DIFF-007 | Empty `diff` → renders no lines (root still present for testids) | true |
| CMP-CODE-DIFF-008 | Plain non-diff string → every line rendered as `context` | true |
| CMP-CODE-DIFF-009 | TS-language hint: a `+ const x = 1;` line tokenizes the trailing content (keyword `const`, ident `x`, etc.) | spans with `tk-keyword`, `tk-ident` present |
| CMP-CODE-DIFF-010 | `data-testid` overridable via prop | true |
| CMP-CODE-DIFF-011 | Auto-detect language from `+++ b/foo.ts` header | resulting added lines tokenize as TS |
| CMP-CODE-DIFF-012 | Lines preserve trailing whitespace exactly (alignment intact) | true |

### `<ApprovalPanel>` (CMP-APPROVAL-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-APPROVAL-001 | Root has `data-testid="approval-panel-root"` | true |
| CMP-APPROVAL-002 | Header text "Approval Required" rendered | true |
| CMP-APPROVAL-003 | Plan text rendered when `approval.plan` is non-empty; section hidden when empty | true |
| CMP-APPROVAL-004 | Files-to-modify list rendered when `approval.filesToModify` is non-empty | true |
| CMP-APPROVAL-005 | Files list shows file-type icon and full path | each item has data-testid `approval-file-{i}` |
| CMP-APPROVAL-006 | Diff section renders `<CodeDiff>` with `approval.diff` when non-empty | data-testid `approval-diff` present |
| CMP-APPROVAL-007 | Action bar renders three buttons with mandated testids | `approve-button`, `modify-button`, `reject-button` |
| CMP-APPROVAL-008 | Click Approve → calls `onApprove(runId)` once | true |
| CMP-APPROVAL-009 | Click Approve → defaults to `window.api.runs.approve({ runId })` | spy called with `{ runId }` |
| CMP-APPROVAL-010 | Click Reject → calls `onReject(runId)` (default → `window.api.runs.reject`) | true |
| CMP-APPROVAL-011 | Click Modify → composer `<PromptInput>` is revealed, pre-filled with `approval.plan` | textarea value === approval.plan |
| CMP-APPROVAL-012 | Composer Send → calls `onModify(runId, text)` (default → `window.api.runs.modify`) | true |
| CMP-APPROVAL-013 | Empty Modify text → Send disabled (PromptInput's existing rule); `onModify` not called | true |
| CMP-APPROVAL-014 | While an action is in flight, all three buttons disabled | true |
| CMP-APPROVAL-015 | `disabled === true` → all three buttons disabled (regardless of pendingAction) | true |
| CMP-APPROVAL-016 | Empty `filesToModify` and empty `diff` → those sections do not render | true |
| CMP-APPROVAL-017 | Modify composer can be re-collapsed (clicking Modify again hides it) | true |

### `<ExecutionView>` integration (EXEC-APPROVAL-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| EXEC-APPROVAL-001 | When `run.pendingApproval === null`, no `approval-panel-root` rendered; body data-has-panel="false" | true |
| EXEC-APPROVAL-002 | When `run.pendingApproval` is populated, `approval-panel-root` rendered; body data-has-panel="true" | true |
| EXEC-APPROVAL-003 | The placeholder `execution-approval-placeholder` is removed entirely | query returns null |
| EXEC-APPROVAL-004 | Approve click → `window.api.runs.approve({ runId: ready.id })` called | spy hit |
| EXEC-APPROVAL-005 | Reject click → `window.api.runs.reject({ runId: ready.id })` called | spy hit |
| EXEC-APPROVAL-006 | Modify text + Send → `window.api.runs.modify({ runId, text })` called; `claude.write` NOT called | true |
| EXEC-APPROVAL-007 | Page-bottom `log-prompt-input` still wired to `claude.write` (unchanged regression) | true |
| EXEC-APPROVAL-008 | When state transitions out of awaitingApproval (panel disappears), no errors | true |

## Manual verification (after PR)
- [ ] `npm run dev` regression: ProjectList / ProjectDetail / ExecutionView still work with no checkpoint
- [ ] Trigger a checkpoint (interactive run + skill emits the marker) → right pane shows Approval Required
- [ ] Click Approve → panel disappears, run continues
- [ ] Click Reject → panel disappears, run transitions to cleanup
- [ ] Click Modify → composer reveals pre-filled with the plan; type changes; Send → run continues with edited input
- [ ] When no checkpoint is active, the log fills the full width
- [ ] Diff renders with TS keywords colored on a TS-targeted ticket

## Test Status
- [ ] CMP-SYNTAX-001..012
- [ ] CMP-CODE-DIFF-001..012
- [ ] CMP-APPROVAL-001..017
- [ ] EXEC-APPROVAL-001..008
- [ ] Total project unit tests pass
- [ ] `npm run lint`: 0
- [ ] `npm run typecheck`: 0
- [ ] `npm run build`: clean
