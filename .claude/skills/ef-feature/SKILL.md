---
name: ef-feature
description: End-to-end feature workflow — fetch GitHub issue, understand context, plan, implement with design quality, and evaluate E2E test needs
disable-model-invocation: true
argument-hint: [github-issue-url]
---

# Feature Workflow: $ARGUMENTS

Execute the full feature lifecycle from a GitHub issue through to implementation and E2E test evaluation. This skill orchestrates `/ef-context`, `/ef-plan`, `/ef-implement`, `frontend-design`, and `/ef-baseline` into a single end-to-end workflow.

## Autonomous Flow

This workflow runs **end-to-end without pausing for approval between phases**. Do NOT ask the developer for permission before proceeding from one phase or step to the next — surface progress, then continue automatically.

The only allowed stops are hard errors:
- Invalid GitHub issue URL (Phase 1.1)
- GitHub authentication failure (Phase 1.2)
- Memory bank initialization required (Phase 2.1)
- Review agent verdict requires fixes (Phase 6.2 — fix and re-run, do not ask)

Everything else flows: fetch → context → plan → implement → test → review → ship.

### No interactive prompts

When this skill runs inside e-frank's WorkflowRunner, **stdin is not a terminal** — there is no human to type a follow-up answer. Asking a question and waiting for input causes Claude to hang for ~3 seconds, see no stdin, and proceed without it (or print an apology and give up). On any hard error, **print a clear one-line error and exit** instead of asking. The runner surfaces the printed error in the UI; the developer fixes the input and re-runs.

The plan-review approval marker (`<<<EF_APPROVAL_REQUEST>>>`) is the *only* sanctioned interactive checkpoint — e-frank's UI handles it via a dedicated stdin write on `approve\n`. Don't invent other ones.

## Phase Markers (e-frank integration)

When this skill runs inside e-frank's `WorkflowRunner`, the runner watches Claude's stdout for **phase markers** — single-line tags that drive the UI timeline. Emit one with a plain `echo` at the start of each runner-relevant phase:

```bash
echo '<<<EF_PHASE>>>{"phase":"branching"}<<<END_EF_PHASE>>>'
```

The marker fits on one line (no embedded newlines). Valid `phase` values:

- `branching` — feature branch is being created (Phase 0). May include a `branchName` field carrying the actual branch — the runner uses it to update `Run.branchName` so the UI shows the real name.
- `committing` — staging + git commit in progress (Phase 7.1)
- `pushing` — pushing branch to remote (Phase 7.2)
- `creatingPr` — opening the pull request (Phase 7.3). May include a `prUrl` field — the runner stores it on `Run.prUrl`.
- `updatingTicket` — updating the ticket source (Phase 7.4)

Markers are best-effort. If Claude isn't running inside e-frank, the `echo` lines are harmless. The marker contract is documented in `memory-bank/systemPatterns.md`.

The existing approval marker (`<<<EF_APPROVAL_REQUEST>>>...<<<END_EF_APPROVAL_REQUEST>>>`) is unchanged — phase markers are additive.

## Active Task Tracking

**At the start of each phase**, update `memory-bank/activeTask.md` with current progress. This file survives context compaction and allows you to resume if you lose context. This file is **local per-developer** — ensure `memory-bank/activeTask.md` is in `.gitignore` (add it if missing).

Format:
```markdown
# Active Task
- Skill: /ef-feature
- Skill file: .claude/skills/ef-feature/SKILL.md
- Issue: $ARGUMENTS
- Current phase: [Phase N: name]
- Waiting for: [developer / nothing]

## Completed
- [x] Phase 0: Branch setup (checkout main, create feat branch)
- [x] Phase 1: Fetch GitHub issue
- [x] Phase 2: Understand context (ef-context)
- [x] Phase 3: Plan (ef-plan)
- [x] Phase 4: Implement (ef-implement + frontend-design)
- [x] Phase 5: E2E test evaluation (ef-baseline)
- [x] Phase 6: Code review (ef-review via new agent)
...

## Key Artifacts
- Issue title: [title]
- Issue number: [#N]
- Repo: [owner/repo]
- Plan file: [path]
- Acceptance spec: [path]
- Branch: [branch name]
```

**When the workflow completes** (Phase 6 done), delete `memory-bank/activeTask.md`.

---

## Phase 0: Branch Setup

> **Update `activeTask.md`**: Current phase = Phase 0

Create a clean feature branch from `main`, then emit the phase marker
**including the actual branch name** so e-frank's UI updates from any
pre-Claude placeholder to the real name.

### 0.1: Checkout Main

```bash
git checkout main
git pull origin main
```

### 0.2: Create Feature Branch

Branch naming convention: `feat/{ticketKey}-{slug}` where `slug` is the
first 6 words of the issue title (lowercased, alphanumeric+hyphen,
joined with `-`). This matches the format e-frank pre-derives so the
runner-side and Claude-side names converge.

```bash
git checkout -b feat/{ticketKey}-{slug}
```

After creating the branch, emit the phase marker with the actual branch
name (replace `<actual-branch>` with the real value):

```bash
echo '<<<EF_PHASE>>>{"phase":"branching","branchName":"<actual-branch>"}<<<END_EF_PHASE>>>'
```

Examples: `feat/html-preview`, `feat/response-body-validation`, `feat/workspace-roles`

**Exception:** If the developer specifies a different base branch or an existing branch, use that instead.

---

## Phase 1: Fetch GitHub Issue

> **Update `activeTask.md`**: Current phase = Phase 1

### 1.1: Parse the Issue Reference

`$ARGUMENTS` is one of:

- **A full GitHub issue URL** — `https://github.com/{owner}/{repo}/issues/{number}`. Parse owner / repo / number from the URL.
- **A bare ticket key** — `GH-31`, `ABC-123`, etc. This is what e-frank passes when the skill is launched as part of a workflow run. Resolve owner / repo from the current git remote:

  ```bash
  git remote get-url origin
  # https://github.com/owner/repo.git → owner/repo
  # git@github.com:owner/repo.git → owner/repo
  ```

  The number is the digit portion of the ticket key (`GH-31` → `31`, `ABC-123` → `123`).

If the argument matches neither shape, **fail loud and exit**: print a one-line error like `[ef-feature] could not parse $ARGUMENTS as a GitHub URL or ticket key (e.g. GH-31)` and stop. **Do NOT prompt the developer interactively.** When this skill runs inside e-frank's WorkflowRunner there is no stdin channel — Claude will hang for ~3 seconds, see no input, then give up. The runner surfaces the printed error in the UI; the developer fixes the input and re-runs.

### 1.2: Fetch Issue Details

Try fetching the issue using **GitHub MCP** first:
- Use `mcp__github-server__get_issue` with the extracted owner, repo, and issue number

If MCP fails (e.g., authentication error), fall back to **gh CLI**:
- `gh issue view {number} --repo {owner}/{repo} --json title,body,labels,assignees,state,comments`

If both fail, **fail loud and exit**: print `[ef-feature] GitHub auth failed; run `gh auth login` or configure the GitHub MCP token` and stop. Same rule as Phase 1.1 — no interactive prompts when running under e-frank.

### 1.3: Summarize the Issue

Present the issue details to the developer:

```
## GitHub Issue Fetched

**#{number}: {title}**
**Labels:** {labels}
**State:** {state}

### Description
{body — summarized if very long}

### Key Requirements Extracted
- [requirement 1]
- [requirement 2]
- [requirement 3]

### Acceptance Criteria (from issue)
- [criterion 1]
- [criterion 2]
```

Proceed automatically to Phase 2. Do not pause for approval.

---

## Phase 2: Understand Context

> **Update `activeTask.md`**: Current phase = Phase 2

Run the `/ef-context` skill workflow to ensure the memory bank is up to date and understand what the issue is really about in the context of the project.

### 2.1: Check Memory Bank State

1. Check if `memory-bank/index.md` exists
   - If YES → read it plus all core files (`projectBrief.md`, `techContext.md`, `systemPatterns.md`, `progress.md`) and any topic files relevant to this feature
   - If NO → run `/ef-context` to initialize the memory bank. STOP and wait for initialization to complete before continuing.

### 2.2: Map Issue to Project Context

After reading the memory bank, analyze how this issue relates to the existing codebase:

1. **Identify affected areas** — which files, components, modules, and API routes are involved
2. **Check for related past work** — look at `progress.md` for previous features that overlap
3. **Identify dependencies** — what existing code does this feature depend on
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

Run the `/ef-plan` skill workflow using the issue requirements as the module definition.

### 3.1: Execute Planning

Follow the `/ef-plan` skill steps:

1. **Break down the issue into features** — the issue may describe a single feature or a small module with multiple features
2. **For each feature**, provide:
   - Feature name
   - Description
   - Priority (P0/P1/P2)
   - Dependencies
   - Acceptance direction (derived from the GitHub issue's acceptance criteria + your context analysis)
3. **Suggest development order**
4. **Estimate scope**

### 3.2: Enrich with Issue Context

When generating the plan, incorporate:
- Acceptance criteria from the GitHub issue (Phase 1)
- Context analysis from Phase 2
- Any comments or discussion on the issue (if fetched)

### Plan Summary

Show the plan to the developer for visibility:

```
## Development Plan for #{number}: {title}
- Features: [list]
- Priorities: [P0/P1/P2 breakdown]
- Acceptance direction: [summary]
- Recommended order: [order]
```

Proceed automatically to implementation. Do not pause for approval.

Update `memory-bank/progress.md` with the planned features (prepend to log).

---

## Phase 4: Implement

> **Update `activeTask.md`**: Current phase = Phase 4

Execute implementation using the `/ef-implement` skill workflow, enhanced with `frontend-design` for any UI work.

### 4.1: Implement Each Feature

For each feature in the confirmed plan (in recommended order):

1. **Generate acceptance spec + interface contract** — follow `/ef-implement` Step 2
2. **Save spec and proceed** — write the spec to `acceptance/{feature}.md` and continue automatically. Do not pause for approval.
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

**Feature:** #{number}: {title}
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

- The feature name and issue number
- The branch name
- The acceptance spec path (`acceptance/{feature}.md`)
- Instructions to follow the `/ef-review` skill workflow (Steps 1-7)
- The full contents of the `/ef-review` skill file (`.claude/skills/ef-review/SKILL.md`) so the agent knows the review process
- Explicit instruction: "You are an independent reviewer. Judge the code against project conventions, acceptance spec, and best practices. Actively look for problems."

### 6.2: Process Review Results

When the review agent returns:

**Verdict: Ready for PR** → proceed to Completion.

**Verdict: Fix critical issues first** →
1. Fix the issues identified by the reviewer
2. Re-run the affected tests to confirm fixes
3. Re-launch the review agent to verify fixes
4. Repeat until the verdict is "Ready for PR"

---

## Phase 7: Ship

> **Update `activeTask.md`**: Current phase = Phase 7

After review is `Ready for PR`, ship it. Each sub-phase emits its phase marker first so e-frank's UI timeline reflects the live progress.

### 7.1: Commit

```bash
echo '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>'
```

Stage all changes, then commit with a Conventional-Commits-style message keyed to the issue:

```bash
git add -A
git commit -m "feat({ticketKey}): {short summary derived from issue title}

Closes #{number}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
Co-Authored-By: Claude <noreply@anthropic.com>"
```

If the working tree is clean (nothing to commit) something has gone wrong — STOP and report back to the developer rather than push an empty commit.

### 7.2: Push

```bash
echo '<<<EF_PHASE>>>{"phase":"pushing"}<<<END_EF_PHASE>>>'
git push -u origin HEAD
```

### 7.3: Open PR

Use `gh` to open the pull request. Title: same Conventional-Commits format. Body: short summary + test plan + closing keyword.

```bash
PR_URL=$(gh pr create --title "{commit subject}" --body "$(cat <<'EOF'
## Summary
{1-3 bullets of what changed and why}

## Test plan
- [ ] {bullet from acceptance spec}
- [ ] {bullet from acceptance spec}

Closes #{number}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)")
```

Then emit the phase marker carrying the URL so e-frank's UI links it on the run row:

```bash
echo "<<<EF_PHASE>>>{\"phase\":\"creatingPr\",\"prUrl\":\"$PR_URL\"}<<<END_EF_PHASE>>>"
```

Use the captured `$PR_URL` in the final summary AND in the ticket update.

### 7.4: Update Ticket

```bash
echo '<<<EF_PHASE>>>{"phase":"updatingTicket"}<<<END_EF_PHASE>>>'
```

For Jira tickets, transition to "In Review" (or the project's equivalent) and post the PR URL as a comment:

```bash
# Jira (if connected): transition + comment
# GitHub Issues (if the ticket source is GH): just leave the closing keyword
# in the PR body — GitHub auto-links + auto-closes on merge.
```

If the ticket source is GitHub Issues and the PR body already contains `Closes #{number}`, no extra ticket update is needed — GitHub handles the link.

If the update fails, log it and continue. Ticket-update failure is **non-fatal** — the run still succeeds because the code is shipped.

---

## Completion

> **Delete `memory-bank/activeTask.md`** — the workflow is done.

### Update Memory

Run `/ef-context after-implement` to update the memory bank with everything that was built.

### Final Summary

Present the complete feature summary:

```
## Feature Complete: #{number} — {title}

### Implementation
- Features implemented: X
- Files created/modified: [list]
- Branch: [branch name]
- PR: [URL from Phase 7.3]

### Test Coverage
- API tests: X/X PASS
- E2E tests: X/X PASS
- Regressions: None

### Review
- Verdict: [Ready for PR / Fixed after review]
- Issues found: [count or none]
```
