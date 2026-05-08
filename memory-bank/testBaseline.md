# Test Baseline

Tracks the project's automated test coverage as a baseline reference. Updated whenever a feature adds new test flows.

## Current Coverage (as of #1 scaffold)

### Unit / Integration (Vitest)
| File | Tests | Covers |
|------|-------|--------|
| `tests/unit/ipc-contract.test.ts` | 4 | IPC-001 — `src/shared/ipc.ts` PING contract |
| `tests/unit/ipc-contract-claude.test.ts` | 25 | IPC-CPM-001/002/003 + drift guard — claude:* channels + IpcApi.claude type shape + PING regression |
| `tests/unit/main-ping-handler.test.ts` | 4 | IPC-002, IPC-003 — `handlePing` pure function |
| `tests/unit/scaffold.test.ts` | 8 | SCAFFOLD-001..004 — config files, scripts, strict mode, electron-builder targets |
| `tests/unit/preload-path.test.ts` | 3 | preload built as `.cjs`, electron-vite formats includes cjs, sandbox: true |
| `tests/unit/spawner.test.ts` | 18 | FakeSpawner self-tests — stream emission, exit/error events, kill, stdinWrites |
| `tests/unit/claude-process-manager.test.ts` | 24 | CPM-001..022 (+2 extras) — manager lifecycle, line buffering, cancel/timeout escalation, stdin, validation |
| `tests/unit/project-instance-schema.test.ts` | 22 | VAL-001..017 — Project Instance schema validator (per-field errors, enum, branchFormat placeholders) |
| `tests/unit/project-store.test.ts` | 16 | PS-001..015 — JSON store CRUD, atomic writes, write mutex, schema versioning, cascade delete |
| `tests/unit/secrets-manager.test.ts` | 13 | SM-001..012 — `safeStorage` wrapper, set/get/delete round-trip, plaintext-never-on-disk, backend-unavailable |
| `tests/unit/ipc-contract-projects.test.ts` | 31 | IPC-PS-001..004 — projects/secrets channels, IpcApi extension, drift guard, regression on prior contracts |
| `tests/unit/http-client.test.ts` | 6 | HTTP-001..005 — FakeHttpClient self-tests |
| `tests/unit/ticket-schema.test.ts` | 13 | TICKET-001..005 — Jira issue → Ticket mapping, missing fields, garbage input |
| `tests/unit/jira-client.test.ts` | 21 | JIRA-001..012 — search/testConnection, JQL encoding, auth header, status mapping, token-not-in-error |
| `tests/unit/run-history.test.ts` | 15 | RH-001..011 — markRunning/markProcessed/clearRunning round-trip, atomic writes, persistence |
| `tests/unit/jira-poller.test.ts` | 17 | POLLER-001..015 — start/stop/refresh, mutex, eligibility filter, back-off, AUTH short-circuit, NO_TOKEN, PROJECT_NOT_FOUND |
| `tests/unit/ipc-contract-jira.test.ts` | 27 | IPC-J-001..004 — jira:* channels, IpcApi extension, drift guard on TicketDto, full regression on prior 16 channels + 4 namespaces |
| `tests/unit/App.test.tsx` | 6 | APP-001..006 — App shell render, view routing, sidebar branding, graceful fallback when window.api missing (replaces #1's FE-001..003 — placeholder Ping demo retired) |
| `tests/unit/tokens.test.ts` | 2 | TOKEN-001 — design tokens declared on `:root` |
| `tests/unit/components-button.test.tsx` | 3 | CMP-BTN-001..003 — Button variants, onClick, disabled |
| `tests/unit/components-badge.test.tsx` | 2 | CMP-BDG-001..002 — Badge variants and pulse-dot element |
| `tests/unit/components-toggle.test.tsx` | 2 | CMP-TGL-001..002 — Toggle onChange, disabled blocks change |
| `tests/unit/views-project-list.test.tsx` | 8 | LIST-001..008 — heading, empty state, populated rows, navigation, Auto Mode toggle, loading, error+retry |
| `tests/unit/views-add-project.test.tsx` | 12 | ADD-001..012 — 4 sections, validation, secrets-then-create order, partial failures, Test Connection, mode picker |

| `tests/unit/components-tabs.test.tsx` | 3 | CMP-TABS-001..003 — controlled tablist, click + onChange, disabled tab |
| `tests/unit/components-checkbox.test.tsx` | 4 | CMP-CHK-001..004 — checked toggle, indeterminate glyph, disabled |
| `tests/unit/components-progress.test.tsx` | 2 | CMP-PROG-001..002 — fill width, value clamping |
| `tests/unit/lib-time.test.ts` | 6 | UTIL-TIME-001..006 — formatRelative bands + invalid input fallback |
| `tests/unit/lib-priority.test.ts` | 4 | UTIL-PRI-001..004 — Jira priority normalization |
| `tests/unit/views-project-detail.test.tsx` | 14 | DET-001..014 — header metadata, Auto Mode per-project, multi-select Run, master checkbox indeterminate, tabs, ticket subscription event filter, Active Execution panel |
| `tests/unit/ipc-contract-chrome.test.ts` | 12 | IPC-CHROME-001..003 — chrome:* channel strings, IpcApi.chrome shape, ChromeState/ChromeStateChangedEvent payload shapes |
| `tests/unit/components-titlebar.test.tsx` | 6 | TITLEBAR-001..006 — testid present, controls hidden on macOS, button wiring, initial maximize state reflected, live state-changed subscription, no-op when window.api missing |

**Total unit:** 911 tests pass + 12 pre-existing skipped (#50 added 18 new across two files).

### E2E (Playwright)
| File | Tests | Covers |
|------|-------|--------|
| `tests/e2e/placeholder.spec.ts` | 1 | Runner is wired (1 + 1 === 2) |

**Total E2E:** 1 test (placeholder only). No Electron-driven E2E yet — deferred until first real user flow lands (#2+).

### Static checks
- `npm run lint` — ESLint 9 flat config (TypeScript + React)
- `npm run typecheck` — `tsc --noEmit` on both renderer and node tsconfigs
- `npm run build` — `electron-vite build` produces clean bundles

## Known Gaps
- **Electron-driven E2E**: No automated test launches the actual Electron app and exercises the IPC bridge through a real BrowserWindow + preload. Will be addressed when user flows exist (issue #2+).
- **Hot reload**: Cannot be programmatically asserted; developer must verify manually.
- **Packaging (`npm run dist`)**: Not run in CI yet. SCAFFOLD-004 verifies the `electron-builder.yml` config, but the actual installer build is manual.
- **Custom titlebar (#50)**: Unit tests cover the React component + IPC contract, but the *frameless* behaviour itself (drag region, Aero Snap, double-click-to-maximize, Alt+Space, macOS traffic-light alignment) can only be verified manually via `npm run dev` — no automated coverage of the actual `BrowserWindow` chrome.

## Bugs Discovered
None during #1 or #2 implementation. (#1 had a critical preload-path bug caught by the reviewer pre-merge, plus the sandbox + ESM incompatibility caught by manual `npm run dev` — both fixed and guarded.)
