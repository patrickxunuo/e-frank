# Acceptance: Claude orchestrates the workflow (#37)

## Summary

The WorkflowRunner stops doing git/PR/Jira CLI ops directly. Claude (running `/ef-feature`) orchestrates the entire pipeline; the runner just spawns Claude with the right prompt, parses **phase markers** to drive the UI timeline, parses **approval markers** to pause for review (unchanged), and handles cancel + cleanup.

## Phase-marker contract

Single-line marker emitted by Claude skills, parsed by `WorkflowRunner` from the Claude stdout buffer (same buffer used for approval markers, same line-based delimitation):

```
<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>
```

- **`phase`** (required, string): one of the existing `RunState` values:
  - `branching` — Claude is creating the feature branch
  - `committing` — Claude is staging + committing
  - `pushing` — Claude is pushing to remote
  - `creatingPr` — Claude is opening the PR
  - `updatingTicket` — Claude is updating the ticket source
- Unknown phases: logged at warn level, treated as regular output. (Keeps the marker contract forwards-compatible — a newer skill emitting a future phase value won't crash older runners.)
- Malformed JSON: logged at warn level, treated as regular output. (Matches approval-marker malformed-JSON behaviour.)

When a valid phase marker is parsed, the runner transitions `Run.state` to the new value, appends a step (with the user-visible label), emits `state-changed` + `current-changed`, and persists. Subsequent markers (or approval markers, or Claude exit) close the previous step and open the next.

## Spawn prompt

Claude is spawned with the skill prompt as its first positional arg:

```
claude --dangerously-skip-permissions /<skillName> <ticketRef>
```

For #37 the skill name is hardcoded to `ef-feature`. The `ticketRef` is the ticket key today (e.g. `GH-31`); a follow-up issue may swap to a fully-qualified URL.

## Collapsed state machine

```
idle → locking → running → (awaitingApproval ↔ <observed phase>) → unlocking → done | failed | cancelled
```

`<observed phase>` is whatever phase marker Claude most recently emitted (default: `running`). The runner no longer drives `preparing | branching | committing | pushing | creatingPr | updatingTicket` itself — those values now arrive via markers.

`preparing` is dropped entirely (the prepare-repo step lived in main and is now part of Claude's responsibility).

## Behavioural rules

1. **Spawn**: on `start()`, after `locking` succeeds, runner spawns Claude with `/ef-feature <ticketKey>`. Run.state = `running`.
2. **Phase marker (valid)**: closes the current step, transitions Run.state, opens a new step. The previous step's `userVisibleLabel` is preserved for history.
3. **Phase marker → awaitingApproval**: not allowed. Approval is its own marker. If an approval marker arrives, the current phase is paused (no step close); on `approve` the run resumes the same phase. (`Run.state` flips to `awaitingApproval` for UI; on resume, flips back to whatever the prior phase was.)
4. **Approval marker (existing behaviour)**: unchanged. Interactive: pause until approve/reject/modify. Yolo: write `approve\n` to stdin immediately. Malformed: ignore.
5. **Claude exit**:
   - `reason='completed'` + `exitCode=0` → success path: `unlocking` (markProcessed + clearRunning), terminal `done`
   - `reason='completed'` + non-zero exit → failed path: `unlocking` (clearRunning only), terminal `failed`
   - `reason='cancelled'` → cancelled path: `unlocking` (clearRunning only), terminal `cancelled`
   - `reason='timeout' | 'error'` → failed path
6. **Cancel**: existing semantics. `claudeManager.cancel(runId)` is the trigger; runner waits for the exit event, then routes through `unlocking` to `cancelled`.
7. **gitManager / prCreator / jiraUpdater**: never called by the runner. They stay in the constructor signature for now (back-compat with tests + main.ts wiring) but the runner doesn't invoke them. NodeGitManager is dormant utility for future pre-flight checks.

## State labels

`USER_VISIBLE_LABELS` retains its existing entries — phase labels still render in the UI timeline, just driven by markers instead of direct transitions. `preparing` keeps its `null` label (still in the enum, never observed in the new flow).

## Tests

- **Spawn prompt**: `claude.run` is called with args `['--dangerously-skip-permissions', '/ef-feature ABC-123']` for ticketKey `ABC-123`.
- **Phase marker → state transition**: emit a marker on Claude stdout, runner transitions Run.state and appends a step; emit a second marker, runner closes prior step and opens the next.
- **Phase marker (unknown phase)**: marker with `{"phase":"frobnicating"}` is ignored; Run.state stays at the previous value; warn logged.
- **Phase marker (malformed JSON)**: ignored; warn logged; subsequent valid markers still parse.
- **Approval marker round-trip**: emit approval marker mid-run, state flips to `awaitingApproval`, `approve()` resumes Claude (writes `approve\n` to stdin). Existing tests should keep passing — no semantic change.
- **No git/PR/Jira calls**: in the success path with no markers, none of `gitManager.prepareRepo`, `gitManager.createBranch`, `gitManager.commit`, `gitManager.push`, `prCreator.create`, `jiraUpdater.update` are called.
- **Claude exits 0 cleanly**: success path, terminal `done`, `markProcessed` called.
- **Claude exits non-zero**: failed path, terminal `failed`, `clearRunning` called but NOT `markProcessed`.
- **Cancel**: terminal `cancelled`, `clearRunning` called but NOT `markProcessed`.
- **ef-feature skill emits markers**: SKILL.md update verified by reading the file (regex: `<<<EF_PHASE>>>` appears at least 4 times).
