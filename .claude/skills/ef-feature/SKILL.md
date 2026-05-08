---
name: ef-feature
description: End-to-end feature workflow — fetch Jira ticket, understand context, plan, implement with design quality, and evaluate E2E test needs
disable-model-invocation: true
argument-hint: [jira-ticket-url-or-key]
---

# Feature Workflow: $ARGUMENTS

Execute the full feature lifecycle from a Jira ticket through to implementation and E2E test evaluation. This skill orchestrates `/ef-context`, `/ef-plan`, `/ef-implement`, `frontend-design`, and `/ef-baseline` into a single end-to-end workflow.

## Active Task Tracking

**At the start of each phase**, update `memory-bank/activeTask.md` with current progress. This file survives context compaction and allows you to resume if you lose context. This file is **local per-developer** — ensure `memory-bank/activeTask.md` is in `.gitignore` (add it if missing).

Format:
```markdown
# Active Task
- Skill: /ef-feature
- Skill file: .claude/skills/ef-feature/SKILL.md
- Ticket: $ARGUMENTS
- Current phase: [Phase N: name]
- Waiting for: [developer / nothing]

## Completed
- [x] Phase 0: Branch setup (Story/Task only — skipped for Subtasks)
- [x] Phase 1: Fetch Jira ticket
- [x] Phase 2: Understand context (ef-context)
- [x] Phase 3: Plan (ef-plan)
- [x] Phase 4: Implement (ef-implement + frontend-design)
- [x] Phase 5: E2E test evaluation (ef-baseline)
- [x] Phase 6: Code review (ef-review via new agent)
- [x] Phase 7: Commit
...

## Key Artifacts
- Ticket key: [UBM-1234]
- Ticket title: [title]
- Ticket type: [Story / Task / Subtask]
- Parent (if subtask): [UBM-1200]
- Plan file: [path]
- Acceptance spec: [path]
- Branch: [branch name — or "current branch (subtask)"]
```

**When the workflow completes** (Phase 7 done), delete `memory-bank/activeTask.md`.

---

## Phase 1: Fetch Jira Ticket

> **Update `activeTask.md`**: Current phase = Phase 1

### 1.1: Parse the Ticket Argument

Accept either:
- A Jira ticket key like `UBM-1234`, or
- A Jira URL like `https://emonster.atlassian.net/browse/UBM-1234`.

Extract the ticket key. If the argument is neither, STOP and ask the developer for the correct ticket key or URL.

### 1.2: Fetch Ticket Details

Use the **Atlassian MCP** tool `mcp__claude_ai_Atlassian__getJiraIssue`:
- `cloudId`: `emonster.atlassian.net`
- `issueIdOrKey`: the extracted key
- `responseContentFormat`: `markdown`

If the MCP call fails, STOP and tell the developer to re-authenticate the Atlassian MCP connection.

### 1.3: Summarize the Ticket

Present the ticket details to the developer:

```
## Jira Ticket Fetched

**{KEY}: {title}**
**Type:** {Story / Task / Subtask / Bug}
**Status:** {status}
**Parent:** {parent key + title, if a subtask}
**Priority:** {priority}
**Assignee:** {assignee or "unassigned"}

### Description
{description — summarized if very long}

### Key Requirements Extracted
- [requirement 1]
- [requirement 2]

### Acceptance Criteria (from ticket)
- [criterion 1]
- [criterion 2]
```

Record the **ticket type** — Phase 0 depends on it.

Ask: "I've fetched the ticket. Shall I proceed with branch setup and context analysis?"

Wait for developer confirmation.

---

## Phase 0: Branch Setup (conditional)

> **Update `activeTask.md`**: Current phase = Phase 0

**Run Phase 0 only for Story / Task / Bug tickets. SKIP Phase 0 entirely for Subtasks** — assume the developer is already on the correct branch (typically the branch created by the parent Story/Task ticket run of this skill).

### 0.1: If Ticket is a Subtask

Just record the current branch name in `activeTask.md` (`git branch --show-current`) and proceed to Phase 2. Do NOT run `git checkout main`, do NOT create a new branch, do NOT touch the working tree.

### 0.2: If Ticket is a Story / Task / Bug

1. Confirm the working tree is clean (`git status --short`). If it is not, STOP and ask the developer how to proceed.
2. Checkout `main` and pull:
   ```bash
   git checkout main
   git pull origin main
   ```
3. Create a new branch. Do **NOT** create a git worktree — work inside the existing checkout.
4. Branch name convention:
   ```
   e-moneter-dev/feature/{TICKET-KEY}-{short-kebab-summary}
   ```
   Example: `e-moneter-dev/feature/UBM-1483-storage-management-ui-refactor`.
   - Derive `{short-kebab-summary}` from the ticket title: lowercase, kebab-case, drop articles/tag-prefixes like `[Unimap]`, keep it under ~50 chars.
5. Create + switch:
   ```bash
   git checkout -b e-moneter-dev/feature/{TICKET-KEY}-{short-summary}
   ```

**Exception:** If the developer specifies a different base branch or existing branch, use that instead.

---

## Phase 2: Understand Context

> **Update `activeTask.md`**: Current phase = Phase 2

Run the `/ef-context` skill workflow to ensure the memory bank is up to date and understand what the ticket is really about in the context of the project.

### 2.1: Check Memory Bank State

1. Check if `memory-bank/index.md` exists
   - If YES → read it plus all core files (`projectBrief.md`, `techContext.md`, `systemPatterns.md`, `progress.md`) and any topic files relevant to this feature
   - If NO → run `/ef-context` to initialize the memory bank. STOP and wait for initialization to complete before continuing.

### 2.2: Map Ticket to Project Context

After reading the memory bank, analyze how this ticket relates to the existing codebase:

1. **Identify affected areas** — which files, components, modules, and API routes are involved
2. **Check for related past work** — look at `progress.md` for previous features that overlap
3. **Identify dependencies** — what existing code does this feature depend on; if the ticket is a subtask, re-read the parent Story/Task and any sibling subtasks
4. **Identify risks** — what could break, what needs careful handling

Present a brief context summary:

```
## Context Analysis

**Affected areas:**
- [component/file]: [why]

**Dependencies:**
- [existing feature/code]: [relationship]

**Risks:**
- [risk]: [mitigation]
```

---

## Phase 3: Plan

> **Update `activeTask.md`**: Current phase = Phase 3

Run the `/ef-plan` skill workflow using the ticket requirements as the module definition.

### 3.1: Execute Planning

Follow the `/ef-plan` skill steps:

1. **Break down the ticket into features** — the ticket may describe a single feature or a small module with multiple features
2. **For each feature**, provide:
   - Feature name
   - Description
   - Priority (P0/P1/P2)
   - Dependencies
   - Acceptance direction (derived from the Jira ticket's acceptance criteria + your context analysis)
3. **Suggest development order**
4. **Estimate scope**

### 3.2: Enrich with Ticket Context

When generating the plan, incorporate:
- Acceptance criteria from the Jira ticket (Phase 1)
- Context analysis from Phase 2
- Any comments or discussion on the ticket (if fetched)

### CHECKPOINT — Plan Review

**STOP HERE.** Show the plan to the developer.

Say: "Here is the development plan for {KEY}: {title}. Review the features, priorities, and acceptance direction. You can add, modify, or remove anything. Confirm when ready and I'll start implementation."

Wait for developer confirmation. **NEVER proceed to implementation without plan confirmation.**

After confirmation, update `memory-bank/progress.md` with the planned features (prepend to log).

---

## Phase 4: Implement

> **Update `activeTask.md`**: Current phase = Phase 4

Execute implementation using the `/ef-implement` skill workflow, enhanced with `frontend-design` for any UI work.

### 4.1: Implement Each Feature

For each feature in the confirmed plan (in recommended order):

1. **Generate acceptance spec + interface contract** — follow `/ef-implement` Step 2
2. **CHECKPOINT** — get developer confirmation on spec
3. **Launch Agent Team** — follow `/ef-implement` Step 3:
   - **Agent A (Test Writer)** — writes tests from the spec
   - **Agent B (Implementer)** — writes implementation from the spec
   - **For features with UI components**: Agent B's prompt MUST include the `frontend-design` skill guidelines:
     - Follow the Design Thinking and Frontend Aesthetics Guidelines from the `frontend-design` skill
     - Match the existing project's design system (CSS variables, theme, typography from `App.css`)
     - Ensure UI components have `data-testid` attributes for E2E testing
     - Create visually polished, production-grade UI that integrates seamlessly with the existing app
4. **Run tests & reconcile** — follow `/ef-implement` Step 4
5. **Final verification** — follow `/ef-implement` Step 5

### 4.2: Cross-Feature Integration

After all features are implemented:
1. Run the full test suite to catch integration issues
2. Verify all features work together as expected
3. Show final implementation summary

---

## Phase 5: E2E Test Evaluation

> **Update `activeTask.md`**: Current phase = Phase 5

Evaluate whether the new feature needs additional E2E test coverage using the `/ef-baseline` skill.

### 5.1: Check Existing Coverage

1. Read `memory-bank/testBaseline.md` if it exists — check current E2E coverage
2. Review what Agent A already wrote during Phase 4 — E2E tests may already be sufficient

### 5.2: Evaluate E2E Needs

Determine if additional E2E tests are needed beyond what Agent A wrote:

**Additional E2E tests are needed if:**
- The feature introduces new user-facing flows not covered by Agent A's tests
- The feature modifies existing flows that have baseline E2E tests (regression risk)
- The feature has complex multi-step interactions that warrant dedicated E2E scenarios
- The feature integrates with other features in ways not tested individually

**Additional E2E tests are NOT needed if:**
- Agent A already wrote comprehensive E2E tests covering all user flows
- The feature is purely backend with no UI changes
- The feature is a minor UI tweak with no new flows

### 5.3: Write Additional E2E Tests (if needed)

If additional tests are needed:

1. Follow `/ef-baseline` "Write Tests for Flow" workflow
2. Add the new flows to `memory-bank/testBaseline.md`
3. Run all E2E tests (new + existing) to verify no regressions
4. **Open the HTML test report** for the developer to review

### 5.4: Update Test Baseline

Update `memory-bank/testBaseline.md`:
- Add any new flows covered by this feature
- Update progress counters
- Record any bugs discovered

### E2E Evaluation Summary

Present the evaluation result:

```
## E2E Test Evaluation

**Ticket:** {KEY}: {title}
**Agent A E2E tests:** X tests covering [flows]
**Additional E2E tests needed:** Yes/No
**Reason:** [why or why not]

### If additional tests were written:
- New test file(s): [paths]
- New flows covered: [list]
- All E2E tests passing: Yes/No

### Overall E2E status:
- Total E2E tests: X
- All passing: Yes/No
```

---

## Phase 6: Code Review

> **Update `activeTask.md`**: Current phase = Phase 6

After all tests pass, launch a **new agent** to perform a code review using the `/ef-review` skill. The review must run in a separate agent to ensure clean context — a reviewer should not review their own work.

### 6.1: Launch Review Agent

Use the **Agent tool** to launch a review agent. The agent's prompt must include:

- The feature name and ticket key
- The branch name (or "current branch" if this is a subtask run)
- The acceptance spec path (`acceptance/{feature}.md`)
- Instructions to follow the `/ef-review` skill workflow (Steps 1-7)
- The full contents of the `/ef-review` skill file (`.claude/skills/ef-review/SKILL.md`) so the agent knows the review process
- Explicit instruction: "You are an independent reviewer. Judge the code against project conventions, acceptance spec, and best practices. Actively look for problems."

### 6.2: Process Review Results

When the review agent returns:

**Verdict: Ready for commit** → proceed to Phase 7.

**Verdict: Fix critical issues first** →
1. Fix the issues identified by the reviewer
2. Re-run the affected tests to confirm fixes
3. Re-launch the review agent to verify fixes
4. Repeat until the verdict is "Ready for commit"

---

## Phase 7: Commit

> **Update `activeTask.md`**: Current phase = Phase 7

Stage the changes and create a commit on the current branch. **Do NOT push.** **Do NOT open a pull request.** The developer handles push + PR manually.

### 7.1: Stage + Commit

1. `git status --short` to review changes.
2. `git add` the specific files that are part of this ticket (avoid blanket `git add -A` so stray files aren't included).
3. Commit with a concise, English message that references the ticket key and describes the change (not the process). Example:
   ```
   UBM-1483: refactor Storage Management page to 2026 Unimap1.0 design
   ```
   - Do not add `Co-Authored-By` / `Generated by` / any AI attribution (per project CLAUDE.md).
   - Do not modify git user config.

### 7.2: Confirm

After the commit succeeds, run `git log -1 --stat` and show the developer:
- The commit hash and message
- The files included
- The current branch name

Tell the developer: "Commit created on `{branch}`. Push and open the PR manually when ready."

---

## Completion

> **Delete `memory-bank/activeTask.md`** — the workflow is done.

### Update Memory

Run `/ef-context after-implement` to update the memory bank with everything that was built.

### Final Summary

Present the complete feature summary:

```
## Feature Complete: {KEY} — {title}

### Implementation
- Features implemented: X
- Files created/modified: [list]
- Branch: [branch name]
- Commit: [hash + subject]

### Test Coverage
- API tests: X/X PASS
- E2E tests: X/X PASS
- Regressions: None

### Review
- Verdict: [Ready for commit / Fixed after review]
- Issues found: [count or none]

### Next Steps (manual)
1. **Push** — `git push -u origin {branch}` when ready
2. **PR** — open a pull request linking to {KEY}
```
