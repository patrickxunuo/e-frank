# GH-38 — Skill management (discover, install, list)

## Description (client-readable)
A Skills page where the user can see what Claude Code skills are installed locally, find new ones via Claude itself, and install them with one click. Necessary because post-#37 the workflow runner drives Claude via a skill — the user needs to control which skills are available.

Three responsibility lanes, each owned by the layer that's good at it:

| Action | Owner | Why |
|---|---|---|
| **List installed skills** | e-frank (filesystem scan) | Pure read of `~/.claude/skills/*/SKILL.md` and `<cwd>/.claude/skills/*/SKILL.md`. Project-level overrides user-level when slugs collide. |
| **Find / discover skills** | Claude (via `/find-skills`) | Knowledge work — Claude recommends based on the user's stack. e-frank streams the response into the dialog. |
| **Install** | e-frank direct (`npx skills add <ref> -g -y`) | Pure deterministic shell-out. Routing through Claude adds latency + a permission round-trip for zero value. |

## Adaptation Note
- Renderer additions match the existing CSS-Modules + design-tokens style.
- Three new main-process modules sit alongside `skill-installer.ts` (the dev-mode-only sync of the bundled `ef-auto-feature`) — same Spawner abstraction, same fs-injection seam pattern.
- IPC channels are organized under a `skills.*` namespace on `window.api`, mirroring the existing `connections.*` / `runs.*` shape.

## Interface Contract

### Tech stack
- React 18 strict TS, CSS Modules, design tokens (no new theming primitives).
- New runtime deps: **none** — `npx`/`claude` are already on PATH on a dev machine; the project-local seed `ef-auto-feature` skill ships in `.claude/skills/`.
- Main-process modules use only `node:fs/promises`, `node:path`, the existing `Spawner` abstraction. No third-party.

### File structure

```
acceptance/
└── GH-38-skill-management.md                          # NEW (this file)

src/
├── shared/
│   └── ipc.ts                                          # MODIFY — add Skills* + Shell* types, channels, namespace
├── main/
│   ├── index.ts                                        # MODIFY — register handlers, init SkillFinder in initStores,
│   │                                                   #          forward output/exit events to renderer windows
│   └── modules/
│       ├── skills-scanner.ts                           # NEW — scan ~/.claude/skills + <cwd>/.claude/skills,
│       │                                               #        hand-rolled YAML frontmatter parser, project beats user
│       ├── skill-npx-installer.ts                      # NEW — `npx skills add <ref> -g -y`, ref regex hardening
│       └── skill-finder.ts                             # NEW — single-active finder spawning claude `/find-skills`,
│                                                       #        line-buffered stdout/stderr, cancel-kills-process
├── preload/
│   └── index.ts                                        # MODIFY — bridge skills.* + shell.openPath
└── renderer/
    ├── App.tsx                                         # MODIFY — wire `skills` route + nav
    ├── components/
    │   ├── AppShell.tsx                                # MODIFY — route narrowing for `skills`
    │   ├── Sidebar.tsx                                 # MODIFY — `skills` nav item with IconSkills
    │   ├── icons.tsx                                   # MODIFY — IconSkills glyph
    │   ├── FindSkillDialog.tsx                         # NEW
    │   └── FindSkillDialog.module.css                  # NEW
    ├── state/
    │   └── skills.ts                                   # NEW — `useSkills()` hook (list + refresh)
    └── views/
        ├── Skills.tsx                                  # NEW — page (DataTable + EmptyState + Find button)
        └── Skills.module.css                           # NEW

tests/unit/
├── skills-scanner.test.ts                              # NEW — frontmatter parsing, project-vs-user precedence
├── skill-npx-installer.test.ts                         # NEW — happy path + ref regex rejection + stderr surfacing
├── skill-finder.test.ts                                # NEW — single-active guard, cancel kills, line-buffered emit
├── state-skills.test.tsx                               # NEW — useSkills hook (loading/error/refresh)
├── components-find-skill-dialog.test.tsx               # NEW — search submit, candidate parsing, install
└── views-skills.test.tsx                               # NEW — page render, empty state CTA, refresh button
```

### IPC channels

```
skills:list           → IpcResult<{ skills: SkillSummary[] }>
skills:install        → IpcResult<{ status: 'installed' | 'failed'; stdout: string; stderr: string }>
skills:find-start     → IpcResult<{ findId: string; pid: number | undefined; startedAt: number }>
skills:find-cancel    → IpcResult<{ findId: string }>
skills:find-output    (event, main → renderer)
skills:find-exit      (event, main → renderer)
shell:open-path       → IpcResult<null>   # companion: open a skill folder in OS file manager
```

`SkillSummary` shape:
```ts
{
  id: string;            // stable composite — `${source}:${slug}` so collisions don't share an id
  name: string;          // from frontmatter `name`, falls back to dirname
  description: string;   // from frontmatter `description`, may be ''
  source: 'user' | 'project';
  dirPath: string;       // absolute path so the Open button can hand to shell.openPath
}
```

### Main-process modules

**`skills-scanner.ts`** — accepts injected `fs` + `userHome` + `cwd` deps so tests can use a fake fs. Walks `~/.claude/skills/*/SKILL.md` and `<cwd>/.claude/skills/*/SKILL.md`. Hand-rolled `---` frontmatter parser (key: value, no nesting — keeps the dep surface tiny). Returns scans sorted by name. Project-level entries with the same slug as user-level entries override them.

**`skill-npx-installer.ts`** — `Spawner`-wrapped invocation of `npx skills add <ref> -g -y`. The `<ref>` is regex-checked against `^[a-zA-Z0-9][\w./@-]+$` to harden against `shell: true` injection (the spawner default). `cwd` is the userData dir so `npx` cache hits the standard location. Captures stdout + stderr; returns `{ status: 'installed' | 'failed', stdout, stderr }`.

**`skill-finder.ts`** — single-active finder (`FinderAlreadyActiveError` if a second `start()` lands while one's running). Spawns `claude --dangerously-skip-permissions -p /find-skills "<query>"`. EventEmitter for `output` (line-buffered) + `exit`. Query length capped at 200 chars + rejected for shell metachars by the IPC handler in `main/index.ts` BEFORE reaching the finder.

### Renderer

**`useSkills()`** in `state/skills.ts` — mirrors `state/connections.ts` shape: `{ skills, loading, error, refresh }`. Initial fetch on mount; manual refresh via the returned function.

**`Skills.tsx`** — page layout matches `Connections.tsx` / `ProjectList.tsx`. Header has Refresh + "Find Skill" primary button. Body is a `DataTable` (Name · Description · Source · Actions=[Open]) or `EmptyState` ("Install ef-feature to unlock the human-paced ticket-to-PR workflow" CTA → open Find dialog prefilled with `ef-feature`).

**`FindSkillDialog.tsx`** — `Dialog` (size lg). Search input → submit fires `skills.findStart`. Stream area renders streamed output line-by-line (auto-scrolls only when pinned to bottom). Candidate-parser regex picks lines matching `^[-*•]\s+<ref>\s*[:—-]\s*<description>$` and renders each with an inline Install button. Manual install input at the bottom for refs the regex misses.

### Security

- Query string going into `skill-finder.ts` is validated in the handler (`SKILLS_FIND_START`): max 200 chars, rejects ``[\`$<>|&;"'\\(){}[\]\r\n\t]`` (everything cmd.exe / sh treats as a separator or substitution).
- Install ref going into `skill-npx-installer.ts` is regex-checked at the module entry; the IPC handler is a thin pass-through.
- Both spawn paths run with `shell: true` (the NodeSpawner default) for Windows `.cmd` shim resolution; the validation is the defense.

## Acceptance

### Backend
- [x] `skills:list` returns scanned skills with name + description + source + dirPath.
- [x] Project-level skills with the same slug as user-level override them in the response.
- [x] Hand-rolled frontmatter parser handles `name: ...` + `description: ...` (single-line values; multi-line bodies pass through untouched).
- [x] `skills:install` rejects refs that don't match `^[a-zA-Z0-9][\w./@-]+$` BEFORE spawning.
- [x] `skills:install` surfaces stdout + stderr + a status flag so the renderer can show a useful error.
- [x] `skills:find-start` rejects empty / >200-char / shell-metachar-bearing queries.
- [x] `skills:find-start` returns `ALREADY_ACTIVE` (FinderAlreadyActiveError) when a second `start()` lands during an active find.
- [x] `skills:find-cancel` kills the active claude process; subsequent calls return `FINDER_NOT_ACTIVE`.
- [x] `skills:find-output` and `skills:find-exit` broadcast to all renderer windows.
- [x] `SkillFinder` is initialized in `initStores()` (late, after userData is known); if init fails handlers surface `NOT_INITIALIZED` rather than crashing.

### Renderer
- [x] Sidebar shows a `skills` nav item between Connections and Settings.
- [x] Clicking the nav routes to `<Skills />`; back-nav from skill detail (Open button) is via the OS file manager (no in-app skill detail page).
- [x] Skills page testid: `skills-page`.
- [x] DataTable row testid: `skill-row-{id}`.
- [x] Empty state CTA opens the Find dialog prefilled with `ef-feature`.
- [x] Find Skill dialog testid: `find-skill-dialog`.
- [x] Search input testid: `find-skill-search`; submit kicks off `skills.findStart`.
- [x] Streaming output renders line-by-line; auto-scrolls only when user is at the bottom (8px epsilon).
- [x] Candidate lines surface as inline rows with `find-skill-install-{ref}` Install buttons.
- [x] Manual install input (`find-skill-install-input` + `find-skill-install-manual`) covers refs the candidate regex misses.
- [x] Install failure surfaces in `find-skill-install-error` (status='failed' path + IPC error path both covered).
- [x] After a successful install the dialog refreshes the parent skill list via `onInstalled` callback.

### Test coverage
- [x] Vitest unit suite passes: 1068 tests including the 6 new test files for this feature.
- [x] testids assert against acceptance: `skills-page`, `skill-row-{id}`, `find-skill-dialog`, `find-skill-search`, `find-skill-install-{ref}` all verified.

## Out of scope
- Per-project default skill picker — filed separately as GH-39.
- Per-run skill override (Run button split menu) — also GH-39.
- A built-in skill marketplace / catalog browsing — `/find-skills` IS the catalog for now.
- Uninstall / update — out of scope for v1; the user can run `npx skills remove ...` manually or open the folder via the Open button and delete.
- Skill detail page inside the app — clicking Open opens the folder in the OS file manager (single-purpose, simpler).
