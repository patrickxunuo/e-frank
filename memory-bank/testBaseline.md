# Test Baseline

Tracks the project's automated test coverage as a baseline reference. Updated whenever a feature adds new test flows.

## Current Coverage (as of #1 scaffold)

### Unit / Integration (Vitest)
| File | Tests | Covers |
|------|-------|--------|
| `tests/unit/ipc-contract.test.ts` | 4 | IPC-001 — `src/shared/ipc.ts` PING contract |
| `tests/unit/ipc-contract-claude.test.ts` | 21 | IPC-CPM-001/002/003 — claude:* channels + IpcApi.claude type shape + PING regression |
| `tests/unit/main-ping-handler.test.ts` | 4 | IPC-002, IPC-003 — `handlePing` pure function |
| `tests/unit/scaffold.test.ts` | 8 | SCAFFOLD-001..004 — config files, scripts, strict mode, electron-builder targets |
| `tests/unit/preload-path.test.ts` | 3 | preload built as `.cjs`, electron-vite formats includes cjs, sandbox: true |
| `tests/unit/spawner.test.ts` | 18 | FakeSpawner self-tests — stream emission, exit/error events, kill, stdinWrites |
| `tests/unit/claude-process-manager.test.ts` | 24 | CPM-001..022 (+2 extras) — manager lifecycle, line buffering, cancel/timeout escalation, stdin, validation |
| `tests/unit/App.test.tsx` | 4 | FE-001, FE-002, FE-003 — placeholder UI render + ping flow + graceful fallback |

**Total unit:** 86 tests, all PASS.

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

## Bugs Discovered
None during #1 or #2 implementation. (#1 had a critical preload-path bug caught by the reviewer pre-merge, plus the sandbox + ESM incompatibility caught by manual `npm run dev` — both fixed and guarded.)
