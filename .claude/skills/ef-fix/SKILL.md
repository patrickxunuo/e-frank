---
name: ef-fix
description: Lightweight bug fix workflow using Agent Team - investigate, then parallel regression test + fix agents. Escalates to /ef-plan + /ef-implement if the bug involves new requirements or architectural changes.
disable-model-invocation: true
argument-hint: [bug-description or ticket-ID]
---

# Fix Bug: $ARGUMENTS

Lightweight workflow for fixing bugs. Follow every step in order.

**Scope rule**: This skill is for **isolated bug fixes** — wrong behavior that should be corrected with minimal code changes. If investigation reveals the fix requires new features, architectural changes, or cross-module redesign, STOP and escalate (see Complexity Gate in Step 2).

## Active Task Tracking

**At the start of each step**, update `memory-bank/activeTask.md` with current progress. This file is **local per-developer** — ensure `memory-bank/activeTask.md` is in `.gitignore` (add it if missing).

Format:
```markdown
# Active Task
- Skill: /ef-fix
- Skill file: .claude/skills/ef-fix/SKILL.md
- Bug: $ARGUMENTS
- Current step: [Step N: name]
- Waiting for: [developer / nothing]

## Completed
- [x] Step 1: Context read
- [x] Step 2: Investigate & reproduce
...

## Key Artifacts
- Root cause: [one-line summary]
- Regression test file: [path]
- Jira ticket: [ID or N/A]
```

**When the workflow completes** (Step 6 done), delete `memory-bank/activeTask.md`.

## Step 1: Understand Context
> **Update `activeTask.md`**: Current step = Step 1

0. **Guard**: If `memory-bank/index.md` does not exist, STOP — tell the developer: "Memory bank not initialized. Run `/ef-context` first, then come back to `/ef-fix`."
1. Read `memory-bank/index.md` — find all relevant context files
2. Read `memory-bank/techContext.md` — tech stack
3. Read `memory-bank/systemPatterns.md` — code conventions
4. Read `memory-bank/devSetup.md` if it exists
5. If $ARGUMENTS looks like a Jira ticket ID and Jira is configured, look it up via MCP tools — pull description, steps to reproduce, and linked issues
6. If a Jira ticket was found, **assign it to the current developer** (get account ID via `atlassianUserInfo` MCP tool) and transition it to **"In Progress"**
7. If Confluence is configured, search for related context

## Step 2: Investigate & Reproduce
> **Update `activeTask.md`**: Current step = Step 2

### Locate the Bug
1. Reproduce: find or follow steps to reproduce. Start the dev environment if needed (check `devSetup.md` or run `/ef-dev`).
2. Trace the code path — read the relevant source files, logs, error messages
3. Identify the root cause — pinpoint the exact location and reason for the wrong behavior

### Complexity Gate

After investigation, classify the bug:

**Simple fix** (continue with this skill):
- Root cause is clear and localized (1-3 files)
- Fix is a correction of existing logic, not new functionality
- No API contract changes, no new database migrations, no new UI flows
- Estimated change: under ~50 lines of meaningful code

**Complex / requires new requirements** (STOP and escalate):
- Fix requires adding a new feature or changing existing feature behavior
- Multiple modules or services need coordinated changes
- Database schema changes or API contract changes are needed
- Business rules are unclear or need product input
- The "bug" is actually a missing feature or a design gap

If **complex**, STOP HERE. Tell the developer:

> "This bug is more complex than a simple fix. It involves [explain: new requirements / architectural changes / unclear business rules / etc.]. I recommend:"
> 1. `/ef-plan [module]` — to break down the required changes
> 2. `/ef-implement [feature]` — to implement with full TDD workflow
> 3. `/ef-review` — to review before PR
>
> "This ensures proper acceptance specs and test coverage for the scope of changes needed."

Delete `memory-bank/activeTask.md` and stop.

### Report Root Cause

If **simple fix**, present findings to the developer:

```
Bug: [description]
Root cause: [explanation]
Location: [file:line]
Fix approach: [1-2 sentences]
Files to change: [list]
```

Say: "This is a straightforward fix. Confirm and I'll write a regression test, then fix it."

Wait for developer confirmation before proceeding.

## Step 3: Launch Agent Team
> **Update `activeTask.md`**: Current step = Step 3

Announce the agent team to the developer:

Say: "Launching the Agent Team for this bug fix:
- **Agent A (Test Writer)** — writes a regression test that reproduces the bug. Does NOT run the test until signaled.
- **Agent B (Implementer)** — writes the minimal fix for the bug. Does NOT see Agent A's test.
Both agents work from the same root cause analysis but independently."

### Launch Agents in Parallel

Use the **Agent tool** to launch both agents simultaneously. Both receive the root cause analysis from Step 2, tech context, and system patterns — but NOT each other's work.

**Agent A (Test Writer)** prompt must include:
- The root cause analysis (bug description, root cause, location, fix approach)
- Tech stack from `techContext.md` and conventions from `systemPatterns.md`
- Clear instructions:
  - Write a regression test that **reproduces the bug** — it should assert the **correct** (expected) behavior, so it fails on the current code
  - Determine the right test type: API/backend bug → API test, UI bug → Playwright E2E test (MUST hit real backend, no mocks), both → write both
  - Name the test clearly: `test_bug_[short_description]` or `Bug: [description]`
  - Do NOT run the test — just write it and report what files were created
  - Do NOT write any fix code

**Agent B (Implementer)** prompt must include:
- The root cause analysis (bug description, root cause, location, fix approach)
- Tech stack from `techContext.md` and conventions from `systemPatterns.md`
- Clear instructions:
  - Apply the **minimal fix** to correct the behavior
  - Follow conventions in `systemPatterns.md`
  - Fix only the bug — do not refactor surrounding code, add features, or "improve" unrelated code
  - Do NOT write any test code — that is Agent A's job
  - Do NOT run any tests — just write the fix and report what files were changed

## Step 4: Run Tests & Reconcile
> **Update `activeTask.md`**: Current step = Step 4

### Ensure Dev Environment is Running
Before running tests:
1. Check `memory-bank/devSetup.md` for the startup script, or look for `dev-start.*` at project root
2. If found → run the script
3. If not → run `/ef-dev explore` first
4. If services are already running — skip startup

### Run the Regression Test

Restart services to pick up Agent B's fix, then run Agent A's regression test.

**Test PASSES** → Both agents interpreted the root cause correctly. The fix works and the test validates it. Proceed to Step 5.

**Test FAILS** → eFrank investigates:
1. Read the failing test AND the fix. Determine who is at fault:
   - **Agent A's fault**: Test doesn't correctly reproduce the bug or has wrong assertions
   - **Agent B's fault**: Fix doesn't address the root cause or is incomplete
2. Use **SendMessage** to send fix instructions to the responsible agent — do NOT launch new agents
3. Re-run after fix. Repeat until the regression test passes.
4. If after 2 rounds agents can't resolve → eFrank fixes directly.

If the test passes unexpectedly on the **unfixed** code (before applying Agent B's changes) → the test is wrong or the bug is not reproducible. Send Agent A a correction via SendMessage, or revisit Step 2.

## Step 5: Full Regression
> **Update `activeTask.md`**: Current step = Step 5

1. Run the full test suite (all existing tests + the new regression test)
2. If any existing test broke, fix it — the bug fix should not introduce regressions
3. **Open the test report** for the developer to review

Show summary:
```
Bug: [description]
Root cause: [explanation]
Fix: [what changed]
Regression test: [file:line]
All tests: X/X PASS
Regressions: None
Files modified: [list]
```

If a Jira ticket is associated:
1. Transition the ticket to **"Done"** (or equivalent)
2. Add a comment with the fix summary

## Step 6: Update Memory
> **Update `activeTask.md`**: Current step = Step 6

Run `/ef-context after-implement` to update memory bank — record any new pitfalls or patterns discovered during the fix.

**After memory update completes, delete `memory-bank/activeTask.md`** — the workflow is done.

## Next Steps

Tell the developer:

1. **Commit wrapper repo** — If this is a multi-repo project, commit wrapper repo changes (`memory-bank/`) separately from sub-repo code changes. Both need to be committed.
2. **Review** — Open a new session and run `/ef-review` to check code quality before creating a PR.
3. **Worktree cleanup** — If you used a worktree, after the PR is merged: `git worktree remove ../[worktree-name]`.
