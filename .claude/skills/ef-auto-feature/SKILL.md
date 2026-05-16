---
name: ef-auto-feature
description: Autonomous end-to-end feature workflow for e-frank — fetch a ticket (Jira or GitHub Issues), understand context, plan, implement with design quality, evaluate E2E test needs, and ship the PR. Companion to `ef-feature` (the human-paced variant); this one is tuned for e-frank's WorkflowRunner — phase markers, autonomous flow, ships through PR.
disable-model-invocation: true
argument-hint: [ticket-key-or-url]
---

# Auto Feature Workflow: $ARGUMENTS

> **Companion to `ef-feature`.** That skill is the human-paced variant — fetches a Jira ticket, pauses for confirmation at each phase, commits, and lets you push manually. This `ef-auto-feature` skill is the autonomous variant e-frank's WorkflowRunner spawns: Claude drives the entire pipeline end-to-end through commit + push + PR + ticket update, with phase markers driving the runner UI. Pick `ef-feature` when you want to drive interactively; pick `ef-auto-feature` (or let e-frank pick it) when you want fire-and-forget.

Execute the full feature lifecycle from a ticket through to a pull request. Orchestrates `/ef-context`, `/ef-plan`, `/ef-implement`, `frontend-design`, and `/ef-baseline`.

Supports two ticket sources, detected from the shape of `$ARGUMENTS`:

- **Jira** — keys like `UBM-1234`, `ABC-123`, or URLs like `https://*.atlassian.net/browse/{KEY}`
- **GitHub Issues** — keys like `GH-31`, or URLs like `https://github.com/{owner}/{repo}/issues/{N}`

Source is detected at Phase 1.1; everything after that (branch naming, commit format, phase markers, push, PR, ticket update) is the same across both, with small per-source forks where the API differs.

## Running inside e-frank

This skill is designed to run as a child process of e-frank's `WorkflowRunner` — but it also works standalone in a terminal. Two contracts to honor:

### Phase markers

The runner watches Claude's stdout for one-line markers and uses them to drive its UI timeline:

```
<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>
```

**The contract is simple but strict — get it wrong and the timeline lies to the user:**

- **Marker = START of the action it names**, not the preamble. Don't emit `committing` while you're staging files; emit it the line before `git commit`. Don't emit `pushing` while you're computing the upstream; emit it the line before `git push`.
- **Each phase fires exactly ONCE per run.** The runner has a dedupe guard against accidental re-announces, but you should not rely on it. In particular: do NOT re-emit a phase marker after an approval-resume — the runner restores the prior phase automatically.
- **Emit phase markers in the order phases actually run.** The runner doesn't reorder; it pushes a step for each marker as it arrives.

The full set of phases the runner recognizes:

| Skill phase | Marker `phase` value | When to emit |
| --- | --- | --- |
| Phase 1 — Fetch ticket | `fetchingTicket` | First line of Phase 1, before the ticket fetch call. |
| Phase 0 — Branch setup | `branching` | After the branch exists (so `branchName` is real). May carry `branchName`. |
| Phase 2 — Understand context | `understandingContext` | First line of Phase 2, before reading the memory bank. |
| Phase 3 — Plan | `planning` | First line of Phase 3, before generating the plan. |
| (Phase 3.3 — Plan-review) | (approval marker, not a phase marker) | See "Approval marker" below. |
| Phase 4 — Implement | `implementing` | First line of Phase 4, after approval, before launching agent teams. |
| Phase 5 — E2E test evaluation | `evaluatingTests` | First line of Phase 5. |
| Phase 6 — Code review | `reviewingCode` | First line of Phase 6, before launching the reviewer agent. |
| Phase 7.1 — Commit | `committing` | The line immediately before `git commit`. NOT before `git add`. |
| Phase 7.2 — Push | `pushing` | The line immediately before `git push`. |
| Phase 7.3 — Open PR | `creatingPr` | After `gh pr create` returns — carry `prUrl` so the UI links it. |
| Phase 7.4 — Update ticket | `updatingTicket` | First line of Phase 7.4, before the transition / comment call. |

Two phases carry an optional payload:

- `branching` may include `branchName` (the actual branch you created).
- `creatingPr` may include `prUrl` (the URL `gh pr create` returned).

When standalone, the markers are harmless `echo` lines printed to the terminal.

### Approval marker (plan review)

The Phase 3 plan-review checkpoint emits a structured marker:

```
<<<EF_APPROVAL_REQUEST>>>{"plan":"...","filesToModify":[...],"diff":"...","options":["approve","reject","modify"]}<<<END_EF_APPROVAL_REQUEST>>>
```

When running inside e-frank, the runner pauses, surfaces an ApprovalPanel, and writes `approve\n` (or modify text + `\n`, or kills the run on reject) to Claude's stdin on user confirmation. In yolo mode the runner auto-approves immediately. When running standalone, the marker shows up as text in the terminal — the developer types `approve` and presses enter.

This is the **only sanctioned interactive checkpoint**. Don't invent free-text "Shall I proceed?" prompts elsewhere — within e-frank they cause subtle UX problems (Claude's stdin-silence timeout fires after 3 seconds of no input, before the user can navigate to the textarea).

**Prose-question contract (#GH-88).** If at any point you would naturally ask the user a question — for ANY reason, including resolving ambiguity in the ticket, choosing between approaches, confirming a non-obvious decision, or saying "I'm not sure which X you want" — you MUST emit `<<<EF_APPROVAL_REQUEST>>>` with the question as the `plan` field and the choices as the `options` field. **Asking in prose is forbidden** and will trip the runner's `UnstructuredQuestionError` detector: the run terminates `failed` with the question text surfaced in the run log, instead of silently completing as `done` with no changes. When the ticket is too ambiguous to proceed without input, that IS what the approval marker is for — use it rather than streaming an unstructured question.

### Failure handling

On any hard error (malformed `$ARGUMENTS`, ticket fetch failed, working tree dirty, etc.), **print a one-line error and exit non-zero**. Don't ask the developer to fix it interactively — the runner surfaces the error in the UI; the developer fixes it and re-runs.

## Active Task Tracking

**At the start of each phase**, update `memory-bank/activeTask.md` with current progress. This file survives context compaction and allows you to resume if you lose context. **Local per-developer** — ensure `memory-bank/activeTask.md` is in `.gitignore` (add it if missing).

Format:

```markdown
# Active Task
- Skill: /ef-auto-feature
- Skill file: .claude/skills/ef-auto-feature/SKILL.md
- Ticket: $ARGUMENTS
- Source: jira | github
- Current phase: [Phase N: name]

## Completed
- [x] Phase 1: Fetch ticket
- [x] Phase 0: Branch setup (skipped for Jira Subtasks)
- [x] Phase 2: Understand context
- [x] Phase 3: Plan
- [x] Phase 4: Implement
- [x] Phase 5: E2E test evaluation
- [x] Phase 6: Code review
- [x] Phase 7: Ship (commit + push + PR + ticket update)

## Key Artifacts
- Ticket key: [GH-31 / UBM-1234]
- Source: [github / jira]
- Title: [title]
- Type: [Story / Task / Subtask / Bug / Issue]
- Branch: [branch name — or "current branch (subtask)"]
- Commit: [hash + subject]
- PR: [URL]
```

**When the workflow completes** (Phase 7 done), delete `memory-bank/activeTask.md`.

---

## Phase 1: Fetch Ticket

> **Update `activeTask.md`**: Current phase = Phase 1

**Emit the phase marker first** — before any other work in this phase:

```bash
echo '<<<EF_PHASE>>>{"phase":"fetchingTicket"}<<<END_EF_PHASE>>>'
```

### 1.1: Detect source + parse the argument

`$ARGUMENTS` is one of:

| Shape | Source | How to parse |
| --- | --- | --- |
| `https://*.atlassian.net/browse/{KEY}` | Jira | Extract `{KEY}` |
| `https://github.com/{owner}/{repo}/issues/{N}` | GitHub | Extract `{owner}`, `{repo}`, `{N}` |
| `GH-{N}` | GitHub | `{N}` is the issue number; resolve `{owner}/{repo}` from `git remote get-url origin` |
| `[A-Z][A-Z0-9_]*-\d+` (e.g. `UBM-1234`) | Jira | The string itself is the key |

**Resolution order:** if the argument starts with `https://`, route by URL host. Otherwise, if it starts with `GH-` followed by digits, treat as GitHub. Otherwise, if it matches the Jira key regex, treat as Jira.

For GitHub bare keys, parse the remote like:

```bash
git remote get-url origin
# https://github.com/owner/repo.git → owner/repo
# git@github.com:owner/repo.git    → owner/repo
```

If the argument matches none of the shapes, **fail loud and exit**: print `[ef-auto-feature] could not parse $ARGUMENTS as a Jira/GitHub ticket key or URL` and stop. **Do NOT prompt the developer.**

### 1.2: Fetch ticket details

**Jira branch:**

Use the Atlassian MCP tool `mcp__claude_ai_Atlassian__getJiraIssue`:
- `cloudId`: from the URL host if a URL was given (e.g. `emonster.atlassian.net`), else use the project's configured cloud ID. If unknown, default to `emonster.atlassian.net` and fail-loud on auth error.
- `issueIdOrKey`: the extracted key.
- `responseContentFormat`: `markdown`.

If the MCP call fails, **fail loud and exit**: print `[ef-auto-feature] Atlassian MCP unavailable; re-authenticate the connection` and stop.

**GitHub branch:**

Try the GitHub MCP first: `mcp__github-server__get_issue` with `{owner}`, `{repo}`, `{N}`.

If MCP is unavailable, fall back to `gh` CLI:

```bash
gh issue view {N} --repo {owner}/{repo} --json title,body,labels,assignees,state,comments
```

If both fail, **fail loud and exit**: print `[ef-auto-feature] GitHub auth failed; run "gh auth login" or configure the GitHub MCP token` and stop.

### 1.3: Summarize the ticket

Present the ticket details:

```
## Ticket Fetched ({source})

**{KEY}: {title}**
**Type:** {Story / Task / Subtask / Bug / Issue}
**Status:** {status}
**Parent:** {parent key + title, if a Jira subtask}
**Priority:** {priority, if Jira}
**Labels:** {labels, if GitHub or Jira}
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

Record the **ticket type** — Phase 0 forks on it. GitHub Issues don't have subtask hierarchy; treat them as Story-equivalent.

Proceed automatically to Phase 0. **Do NOT pause to ask** — the runner is autonomous.

---

## Phase 0: Branch Setup (conditional)

> **Update `activeTask.md`**: Current phase = Phase 0

**Run Phase 0 for everything EXCEPT Jira Subtasks.** Subtasks inherit their parent Story/Task's branch — running Phase 0 would clobber the developer's working state.

### 0.1: If ticket is a Jira Subtask

Just record the current branch name in `activeTask.md` (`git branch --show-current`) and proceed to Phase 2. Do NOT `git checkout main`, do NOT create a new branch, do NOT touch the working tree.

Emit the branching marker carrying the existing branch name so e-frank's UI shows the right one:

```bash
echo "<<<EF_PHASE>>>{\"phase\":\"branching\",\"branchName\":\"$(git branch --show-current)\"}<<<END_EF_PHASE>>>"
```

### 0.2: If ticket is a Story / Task / Bug / GitHub Issue

1. **Confirm the working tree is clean** — `git status --short`. If it's not, **fail loud and exit**: print `[ef-auto-feature] working tree is dirty; commit or stash first` and stop. Do not auto-stash.

2. **Checkout main and pull:**
   ```bash
   git checkout main
   git pull origin main
   ```

3. **Compute the branch name.** Convention: `feat/{TICKET-KEY}-{short-kebab-summary}`.
   - `{TICKET-KEY}` is the ticket's canonical key (e.g. `GH-31`, `UBM-1234`).
   - `{short-kebab-summary}` is derived from the ticket title: lowercase, kebab-case, drop bracketed tag prefixes (`[Unimap]`, `[backend]`), drop articles, keep it under ~50 characters.
   - Example: `feat/UBM-1483-storage-management-ui-refactor`, `feat/GH-31-show-app-version`.

4. **Create + switch:**
   ```bash
   git checkout -b feat/{TICKET-KEY}-{short-kebab-summary}
   ```

5. **Emit the branching marker AFTER the branch exists,** carrying the actual name so e-frank updates `Run.branchName` from any pre-Claude derivation it might have shown:

   ```bash
   echo "<<<EF_PHASE>>>{\"phase\":\"branching\",\"branchName\":\"$(git branch --show-current)\"}<<<END_EF_PHASE>>>"
   ```

**Exception:** If the developer specifies a different base branch or existing branch via free-text in the ExecutionView textarea, use that instead.

---

## Phase 2: Understand Context

> **Update `activeTask.md`**: Current phase = Phase 2

**Emit the phase marker first:**

```bash
echo '<<<EF_PHASE>>>{"phase":"understandingContext"}<<<END_EF_PHASE>>>'
```

Run the `/ef-context` skill workflow to ensure the memory bank is up to date and understand what the ticket is really about in the context of the project.

### 2.1: Check Memory Bank State

1. Check if `memory-bank/index.md` exists.
   - If YES → read it plus all core files (`projectBrief.md`, `techContext.md`, `systemPatterns.md`, `progress.md`) and any topic files relevant to this feature.
   - If NO → run `/ef-context` to initialize the memory bank. STOP and wait for initialization to complete before continuing.

### 2.2: Map ticket to project context

After reading the memory bank, analyze how this ticket relates to the existing codebase:

1. **Identify affected areas** — which files, components, modules, and API routes are involved.
2. **Check for related past work** — look at `progress.md` for previous features that overlap.
3. **Identify dependencies** — what existing code does this feature depend on; if the ticket is a Jira subtask, re-read the parent and any sibling subtasks.
4. **Identify risks** — what could break, what needs careful handling.

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

Proceed automatically to Phase 3.

---

## Phase 3: Plan

> **Update `activeTask.md`**: Current phase = Phase 3

**Emit the phase marker first:**

```bash
echo '<<<EF_PHASE>>>{"phase":"planning"}<<<END_EF_PHASE>>>'
```

Run the `/ef-plan` skill workflow using the ticket requirements as the module definition.

### 3.1: Execute Planning

Follow the `/ef-plan` skill steps:

1. **Break down the ticket into features** — the ticket may describe a single feature or a small module with multiple features.
2. **For each feature**, provide:
   - Feature name
   - Description
   - Priority (P0/P1/P2)
   - Dependencies
   - Acceptance direction (derived from the ticket's acceptance criteria + your context analysis).
3. **Suggest development order**.
4. **Estimate scope**.

### 3.2: Enrich with ticket context

When generating the plan, incorporate:

- Acceptance criteria from the ticket (Phase 1).
- Context analysis from Phase 2.
- Any comments / discussion on the ticket (if fetched).

### 3.3: Plan-review checkpoint

Emit the structured approval marker so e-frank's ApprovalPanel renders, OR (when standalone) the developer can read the plan and type `approve`:

```bash
cat <<'EOF'
<<<EF_APPROVAL_REQUEST>>>{"plan":"<one-paragraph plan summary>","filesToModify":["src/foo.ts","tests/foo.test.ts"],"diff":"<optional preview diff>","options":["approve","reject","modify"]}<<<END_EF_APPROVAL_REQUEST>>>
EOF
```

Then **read stdin** for the response:

- `approve\n` → continue to Phase 4.
- Any other text starting with `modify ` followed by replacement plan text → adopt the new plan and continue to Phase 4.
- `reject\n` → exit non-zero (the run is cancelled).

In yolo mode, e-frank writes `approve\n` immediately so this is a no-op pause.

After approval, update `memory-bank/progress.md` with the planned features (prepend to log).

---

## Phase 4: Implement

> **Update `activeTask.md`**: Current phase = Phase 4

**Emit the phase marker first** — this is the START of the implementation phase, NOT a re-announce after the approval-resume. The runner has already restored the prior phase on resume; it only needs the new `implementing` marker once.

```bash
echo '<<<EF_PHASE>>>{"phase":"implementing"}<<<END_EF_PHASE>>>'
```

Execute implementation using the `/ef-implement` skill workflow, enhanced with `frontend-design` for any UI work.

### 4.1: Implement each feature

For each feature in the confirmed plan (in recommended order):

1. **Generate acceptance spec + interface contract** — follow `/ef-implement` Step 2.
2. **Save spec and proceed** — write the spec to `acceptance/{feature}.md` and continue automatically. Do not pause.
3. **Launch Agent Team** — follow `/ef-implement` Step 3:
   - **Agent A (Test Writer)** — writes tests from the spec.
   - **Agent B (Implementer)** — writes implementation from the spec.
   - **For features with UI components**: Agent B's prompt MUST include the `frontend-design` skill guidelines — match the existing project's design system (CSS variables, theme, typography), include `data-testid` attributes for E2E testing, produce visually polished production-grade UI.
4. **Run tests & reconcile** — follow `/ef-implement` Step 4.
5. **Final verification** — follow `/ef-implement` Step 5.

### 4.2: Cross-feature integration

After all features are implemented:

1. Run the full test suite to catch integration issues.
2. Verify all features work together as expected.
3. Show final implementation summary.

---

## Phase 5: E2E Test Evaluation

> **Update `activeTask.md`**: Current phase = Phase 5

**Emit the phase marker first:**

```bash
echo '<<<EF_PHASE>>>{"phase":"evaluatingTests"}<<<END_EF_PHASE>>>'
```

Evaluate whether the new feature needs additional E2E test coverage using the `/ef-baseline` skill.

### 5.1: Check existing coverage

1. Read `memory-bank/testBaseline.md` if it exists.
2. Review what Agent A already wrote during Phase 4.

### 5.2: Evaluate E2E needs

**Additional E2E tests are needed if:**

- The feature introduces new user-facing flows not covered by Agent A's tests.
- The feature modifies existing flows that have baseline E2E tests (regression risk).
- The feature has complex multi-step interactions.
- The feature integrates with other features in ways not tested individually.

**Additional E2E tests are NOT needed if:**

- Agent A already wrote comprehensive E2E tests covering all user flows.
- The feature is purely backend with no UI changes.
- The feature is a minor UI tweak with no new flows.

### 5.3: Write additional E2E tests (if needed)

1. Follow `/ef-baseline` "Write Tests for Flow" workflow.
2. Add the new flows to `memory-bank/testBaseline.md`.
3. Run all E2E tests to verify no regressions.

### 5.4: Update test baseline

Update `memory-bank/testBaseline.md`:

- Add any new flows covered by this feature.
- Update progress counters.
- Record any bugs discovered.

---

## Phase 6: Code Review

> **Update `activeTask.md`**: Current phase = Phase 6

**Emit the phase marker first:**

```bash
echo '<<<EF_PHASE>>>{"phase":"reviewingCode"}<<<END_EF_PHASE>>>'
```

After all tests pass, launch a **new agent** to perform a code review using the `/ef-review` skill. Independent context — a reviewer should not review their own work.

### 6.1: Launch review agent

Use the **Agent tool**. Prompt must include:

- Feature name + ticket key.
- Branch name (or "current branch" for subtask runs).
- Acceptance spec path (`acceptance/{feature}.md`).
- Instructions to follow the `/ef-review` skill workflow (Steps 1-7).
- The full contents of `.claude/skills/ef-review/SKILL.md`.
- Explicit instruction: "You are an independent reviewer. Judge the code against project conventions, acceptance spec, and best practices. Actively look for problems."

### 6.2: Process review results

- **Verdict: Ready for PR** → proceed to Phase 7.
- **Verdict: Fix critical issues first** → fix the issues, re-run affected tests, re-launch review. Repeat until "Ready for PR".

---

## Phase 7: Ship

> **Update `activeTask.md`**: Current phase = Phase 7

Commit, push, open PR, update the ticket source. Each sub-step emits its phase marker first so e-frank's UI timeline reflects live progress.

### 7.1: Commit

Stage the specific files involved (avoid blanket `git add -A` so stray files aren't included), then **emit the marker just before `git commit` runs** — the marker names the next action, not the staging that precedes it. This matches the runner's expectation that "Committing changes" means a `git commit` is in flight, not a `git add` rehearsal.

```bash
git add <specific files>
echo '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>'
git commit -m "feat({TICKET-KEY}): {short summary derived from ticket title}

Closes #{N for GitHub} | {KEY for Jira — referenced in body, not closes-keyword}
"
```

- Do NOT add `Co-Authored-By` / `Generated by` / any AI attribution.
- Do NOT modify git user config.
- For GitHub Issues: include `Closes #{N}` so the PR auto-closes the issue on merge.
- For Jira: reference the key in the body (Jira's smart-commit syntax respects `{KEY}` inline).

If the working tree is clean (nothing to commit) something has gone wrong — **fail loud and exit**.

### 7.2: Push

```bash
echo '<<<EF_PHASE>>>{"phase":"pushing"}<<<END_EF_PHASE>>>'
git push -u origin HEAD
```

### 7.3: Open PR

```bash
PR_URL=$(gh pr create --title "{commit subject}" --body "$(cat <<'EOF'
## Summary
{1-3 bullets of what changed and why}

## Test plan
- [ ] {bullet from acceptance spec}
- [ ] {bullet from acceptance spec}

{For GitHub: "Closes #{N}"}
{For Jira: "Ticket: {KEY}"}
EOF
)")
```

Then emit the marker carrying the URL so e-frank's UI links it on the run row:

```bash
echo "<<<EF_PHASE>>>{\"phase\":\"creatingPr\",\"prUrl\":\"$PR_URL\"}<<<END_EF_PHASE>>>"
```

### 7.4: Update ticket

```bash
echo '<<<EF_PHASE>>>{"phase":"updatingTicket"}<<<END_EF_PHASE>>>'
```

**Jira branch:**

Use Atlassian MCP `mcp__claude_ai_Atlassian__transitionJiraIssue` to transition to "In Review" (or the project's review-equivalent transition), and `mcp__claude_ai_Atlassian__addCommentToJiraIssue` to post the PR URL as a comment. If the transition isn't available, just post the comment.

**GitHub branch:**

The `Closes #{N}` keyword in the PR body already links the PR to the issue. No extra step. (When the PR merges, GitHub auto-closes the issue.)

If the update fails, **log a warning and continue**. Ticket-update failure is **non-fatal** — the run still succeeds because the code is shipped.

---

## Completion

> **Delete `memory-bank/activeTask.md`** — the workflow is done.

### Update memory

Run `/ef-context after-implement` to update the memory bank with everything that was built.

### Final summary

```
## Feature Complete: {KEY} — {title}

### Implementation
- Source: [github / jira]
- Features implemented: X
- Files created/modified: [list]
- Branch: [branch name]
- Commit: [hash + subject]
- PR: [URL]

### Test Coverage
- API tests: X/X PASS
- E2E tests: X/X PASS
- Regressions: None

### Review
- Verdict: [Ready for PR / Fixed after review]
- Issues found: [count or none]

### Ticket Update
- [Jira] Transitioned to: In Review (with PR URL comment)
- [GitHub] Closes-keyword in PR body — issue will auto-close on merge
```
