# Progress

## Current Sprint / Focus
Phase 2 complete — Project Detail UI (#6) shipped. Next up Phase 3 — Workflow Runner state machine (#7).

## Log
<!-- Newest entries first. Format: - YYYY-MM-DDTHH:MMZ [status] feature-name (developer) — notes -->
<!-- ALWAYS use UTC time (Z suffix). Run: date -u +"%Y-%m-%dT%H:%MZ" -->
- 2026-05-05T06:00Z [DONE] #5 Project List UI + design system foundation complete. 302/302 unit tests pass (was 271/271 after #4; +31 new across 6 files, plus 4 changed APP-001..006 replacing #1's FE-001..003). 12 design-system primitives, 2 views (ProjectList + AddProject), design tokens on `:root`, dark theme with General Sans + JetBrains Mono. Reviewer verdict: Ready for PR; 4 warnings fixed in-PR (Dialog focus management, hard-coded user identity removed, sidebar gradient + toggle thumb tokenized).
- 2026-05-05T05:30Z [PLAN] #5 Project List UI + design system foundation planned: 12 component primitives, 2 views (ProjectList, AddProject), design tokens on `:root`, dark theme with General Sans + JetBrains Mono. Replaces #1 placeholder ping demo. Defaulting branding to `e-frank`.
- 2026-05-05T05:00Z [DONE] #4 Jira client + ticket polling complete. 271/271 unit tests pass (was 172/172 after #3; +99 new across 6 files). Reviewer verdict Ready for PR after fixing 2 criticals (`tickets.host` field added to schema for production polling; `ticketsDiffer` made set-based to avoid spurious events on Jira reorderings) + 3 warnings (stoppedDueToAuth short-circuit in runPoll, cascade ordering in PROJECTS_DELETE, comment clarification on consecutiveErrors).
- 2026-05-05T03:30Z [PLAN] #4 Jira client + ticket polling planned: 5 modules (http-client abstraction, jira-client REST wrapper, run-history JSON store, jira-poller per-project scheduler, ticket schema). Mirrors prior testability patterns (Spawner, SecretsBackend → HttpClient).
- 2026-05-05T02:50Z [DONE] #3 Project Instance config + secrets storage complete. 172/172 unit tests pass (was 90/90 after #2; +82 new across 4 test files). Reviewer verdict Ready for PR after fixing 1 critical (SecretsManager init failure was silently overwriting corrupt secrets file — now leaves manager null + adds initialized guard) + 4 warnings (NOT_NUMBER code, ProjectStore CRUD init guards, cascade-delete dedup via Set, hide backend error from plaintext leakage path).
- 2026-05-05T01:00Z [PLAN] #3 Project Instance config + secrets storage planned: hand-rolled validator (no zod), JSON file with schema-versioned envelope + atomic writes + write mutex, `safeStorage`-backed SecretsManager via SecretsBackend abstraction (FakeBackend for tests, mirroring #2's Spawner pattern).
- 2026-05-04T09:30Z [DONE] #2 Claude Process Manager complete. 90/90 unit tests pass (added 66 from #1's 23 baseline + 1 drift-guard suite). Reviewer verdict Ready for PR after fixing CRLF stripping for Windows + adding shared↔manager type drift guard. New `Spawner` abstraction in `src/main/modules/spawner.ts` enables full unit testing without spawning real processes.
- 2026-05-04T09:00Z [PLAN] #2 Claude Process Manager planned: one P0 module with Spawner abstraction, single active run, line-buffered IPC streaming, cancel + timeout + stdin support.
- 2026-05-04T08:50Z [DONE] PR #15 (sandbox CJS preload follow-up fix) merged — `npm run dev` now exposes `window.api` correctly with `sandbox: true`.
- 2026-05-04T07:55Z [DONE] #1 Electron + React + Vite scaffold complete. 22/22 unit + 1/1 E2E placeholder pass. Lint + typecheck clean. Build clean. Reviewer verdict: Ready for PR after fixing preload path mismatch (preload built as `.mjs`, main referenced `.js`) — regression-guard test added.
- 2026-05-04T07:25Z [PLAN] #1 scaffold planned as single P0 feature: Electron + React + Vite + IPC + packaging + test configs.
- 2026-05-04T07:21Z [INIT] Memory bank created from PRD content. Stack chosen: Electron + React + TypeScript + Vite + Vitest + Playwright.
- 2026-05-04T07:18Z [INIT] Repo bootstrapped: initial commit on `main`, PRD + ef-* skills + .gitignore. 13 GitHub issues opened covering MVP phases.

## Planned
- [ ] **#1 Electron + React scaffold** (Phase 1) — main process, renderer, dev tooling, IPC, packaging
- [ ] **#2–#3** Jira polling + ticket list UI (Phase 2)
- [ ] **#4–#7** Workflow execution, streaming logs, approval UI (Phase 3)
- [ ] **#8–#11** Git ops, PR creation, Jira update (Phase 4)
- [ ] **#12–#13** Polish / packaging
