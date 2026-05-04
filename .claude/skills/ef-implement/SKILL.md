---
name: ef-implement
description: Full TDD workflow using Agent Team - acceptance spec, then parallel test writer + implementer agents
disable-model-invocation: true
argument-hint: [feature-name]
---

# Implement Feature: $ARGUMENTS

Execute the full TDD development workflow. Follow every step in order. Do NOT skip any step.

## Active Task Tracking

**At the start of each step**, update `memory-bank/activeTask.md` with current progress. This file survives context compaction and allows you to resume if you lose context. This file is **local per-developer** — ensure `memory-bank/activeTask.md` is in `.gitignore` (add it if missing).

Format:
```markdown
# Active Task
- Skill: /ef-implement
- Skill file: .claude/skills/ef-implement/SKILL.md
- Feature: $ARGUMENTS
- Current step: [Step N: name]
- Waiting for: [developer / nothing]

## Completed
- [x] Step 0: Branch isolation
- [x] Step 1: Context read
- [x] Step 2: Acceptance spec + interface contract → acceptance/$ARGUMENTS.md
- [x] CHECKPOINT 1: Developer confirmed spec
- [x] Step 3: Agent Team launched (Agent A: Test Writer, Agent B: Implementer)
- [x] Step 4: Tests run & reconciled
...

## Key Artifacts
- Acceptance spec: acceptance/$ARGUMENTS.md
- Interface contract: [section in acceptance spec]
- Agent A test files: [paths]
- Agent B implementation files: [paths]
- Jira ticket: [ID or N/A]
```

**When the workflow completes** (Step 7 done), delete `memory-bank/activeTask.md`.

## Step 0: Ensure Branch Isolation
> **Update `activeTask.md`**: Current step = Step 0

Check `memory-bank/techContext.md` for repo structure, then suggest worktree per Git Workflow rules in CLAUDE.md:

- **Single repo**: `git worktree add ../[project]-$ARGUMENTS feat/$ARGUMENTS`
- **Multi-repo (wrapper)**: Create worktree inside the wrapper for each repo that will be modified:
  - `cd frontend && git worktree add ../frontend-$ARGUMENTS feat/$ARGUMENTS`
  - `cd backend && git worktree add ../backend-$ARGUMENTS feat/$ARGUMENTS`
  - Use the same ticket ID / feature name across repos for unified naming

If the developer declines, continue — isolation is recommended, not mandatory.

## Step 1: Understand Context
> **Update `activeTask.md`**: Current step = Step 1

0. **Guard**: If `memory-bank/index.md` does not exist, STOP — tell the developer: "Memory bank not initialized. Run `/ef-context` first, then come back to `/ef-implement`."
1. Read `memory-bank/index.md` — find all relevant context files
2. Read `memory-bank/projectBrief.md` — business context
3. Read `memory-bank/techContext.md` — tech stack (determines which test frameworks to use)
4. Read `memory-bank/systemPatterns.md` — code conventions
5. Read `memory-bank/devSetup.md` if it exists — know how to start/stop the dev environment
6. Read any topic-specific memory files relevant to this feature (listed in index.md)
7. Check if there is a module plan that includes this feature (look in `acceptance/` or recent conversation)
8. If Jira is configured in `techContext.md` and the feature references a ticket (e.g., PROJ-123), look it up via MCP tools — pull description, acceptance criteria, and linked issues
9. If Confluence is configured, search for design docs or specs related to this feature
10. If a Jira ticket was found, **assign it to the current developer** (get account ID via `atlassianUserInfo` MCP tool) and transition it to **"In Progress"**

## Step 2: Generate Acceptance Spec + Interface Contract
> **Update `activeTask.md`**: Current step = Step 2

Create file `acceptance/$ARGUMENTS.md` with this structure:

```markdown
# [Feature Name] - Acceptance Criteria

## Description (client-readable)
[1-3 sentences in plain language describing what this feature does]

## Interface Contract
This is the shared agreement between the Test Writer and the Implementer. Both agents receive this full acceptance spec (including this contract) — but not each other's code.

### API Endpoints
| Method | Path | Request Body | Response (success) | Response (error) |
|--------|------|-------------|-------------------|-----------------|
| POST   | /api/[resource] | `{ field: type, ... }` | `200 { id, ... }` | `400 { error }` |
| GET    | /api/[resource]/:id | — | `200 { ... }` | `404 { error }` |
| ...    | ... | ... | ... | ... |

### Data Models
[Key entity shapes — field names, types, required/optional, constraints]

### Business Rules
[Numbered list of rules that both tests and implementation must honor]

### UI Components (if applicable)
[Component names, props, data-testid attributes, key behaviors]

## API Acceptance Tests
| ID | Scenario | Precondition | Request | Expected Response |
|----|----------|-------------|---------|------------------|
| API-001 | [happy path] | [setup] | [method + path + body] | [status + key fields] |
| API-002 | [validation error] | [setup] | [request] | [status + error] |
| API-003 | [auth failure] | [setup] | [request] | [401/403] |
| ... | ... | ... | ... | ... |

## Frontend Acceptance Tests
| ID | User Action | Expected Result |
|----|------------|----------------|
| FE-001 | [core happy path flow] | [what user sees] |
| FE-002 | [main error state] | [what user sees] |
| ... | ... | ... |

## Test Status
- [ ] API-001: Pending
- [ ] FE-001: Pending
```

Guidelines:
- **Interface contract is critical** — it is the ONLY shared information between Agent A and Agent B. Make it precise: exact endpoint paths, exact field names, exact status codes, exact `data-testid` values. Ambiguity here causes mismatches.
- API tests: 5-10 per endpoint. Cover happy path, validation, auth, edge cases.
- Frontend tests: 2-3 per feature. Only core user flow + main error state.
- Think from the client's perspective: "What proves this feature works correctly?"

## CHECKPOINT 1
> **Update `activeTask.md`**: Current step = CHECKPOINT 1, Waiting for = developer

**STOP HERE.** Show the acceptance spec and interface contract to the developer.
Say: "Here is the acceptance spec and interface contract for [feature]. The interface contract is the shared agreement that both the Test Writer and Implementer agents will work from independently. You can add, modify, or remove any test cases or contract details. Confirm when ready and I'll launch the agent team."

Wait for developer confirmation before proceeding. **NEVER launch the agent team without developer confirmation.**

## Step 3: Launch Agent Team
> **Update `activeTask.md`**: Current step = Step 3, Waiting for = nothing

After developer confirms, announce the agent team:

Say: "Launching the Agent Team for [feature]:
- **Agent A (Test Writer)** — writes all test code from the acceptance spec + interface contract. Does NOT run tests until signaled.
- **Agent B (Implementer)** — writes all implementation code from the acceptance spec + interface contract. Does NOT see Agent A's tests.
Both agents work from the same spec but are completely independent — neither sees the other's work."

### Prepare Agent Context

Before launching, gather the shared context both agents will receive:

1. The full acceptance spec + interface contract from `acceptance/$ARGUMENTS.md`
2. Tech stack from `memory-bank/techContext.md` (frameworks, test tools, directory structure)
3. Code conventions from `memory-bank/systemPatterns.md`
4. Dev environment details from `memory-bank/devSetup.md` (if it exists)
5. Any relevant topic memory files

### Multi-Repo Check
Check `memory-bank/techContext.md` for the project's repository structure:
- **Single repo**: Both agents work in the current project
- **Multi-repo**: Each agent MUST place files in the correct repo:
  - Agent A: API/backend tests → backend repo, E2E/frontend tests → frontend repo
  - Agent B: Backend code → backend repo, Frontend code → frontend repo
  - Include the correct repo paths in each agent's prompt

### Launch Agents in Parallel

Use the **Agent tool** to launch both agents simultaneously in a single message. Both agents receive the acceptance spec, interface contract, tech context, and system patterns — but NOT each other's work.

**Agent A (Test Writer)** prompt must include:
- The full acceptance spec + interface contract
- Tech stack and code conventions
- Clear instructions:
  - Write ALL test code (API tests + E2E Playwright tests) based on the acceptance spec and interface contract
  - One test function per acceptance test ID (name clearly: `test_API001_...` or `void API001_...`)
  - API tests: set up test data in before/setup hooks, assert response status + body + side effects
  - E2E tests: use `data-testid` attributes from the interface contract, add screenshots at key steps
  - **NEVER mock or stub API calls** — no `page.route()`, no mock service workers, no fake responses
  - Do NOT run the tests — just write them and report what files were created
  - Do NOT write any implementation code

**Agent B (Implementer)** prompt must include:
- The full acceptance spec + interface contract
- Tech stack and code conventions
- Clear instructions:
  - Write ALL implementation code (backend + frontend) to satisfy the acceptance spec and interface contract
  - Follow code conventions in `systemPatterns.md`
  - Backend: implement API endpoints matching the interface contract exactly (paths, request/response shapes, status codes)
  - Frontend: implement UI components with `data-testid` attributes matching the interface contract exactly
  - Generate unit tests alongside service layer code for complex business logic
  - Do NOT write acceptance/integration/E2E tests — that is Agent A's job
  - Do NOT run any tests — just write the code and report what files were created

### After Both Agents Complete

When both agents return their results:
1. Record what each agent produced in `activeTask.md` (file paths, summary)
2. Review both outputs at a high level — check for obvious issues (wrong directories, missing files)
3. Proceed to Step 4

## Step 4: Run Tests & Reconcile
> **Update `activeTask.md`**: Current step = Step 4

### Ensure Dev Environment is Running
Before running tests, make sure the required services are up:
1. Check `memory-bank/devSetup.md` for the startup script filename, or look for `dev-start.*` at project root
2. If found → run the script
3. If not → run `/ef-dev explore` first to discover, record, and generate the startup script
4. If services are already running (check health endpoints or ports) — skip startup

### Run All Tests

Restart backend and frontend services to pick up Agent B's implementation, then run ALL tests written by Agent A.

After tests finish, **open the HTML test report** (e.g., `npx playwright show-report`) so the developer can see the results visually.

### Interpret Results

**All tests PASS** → Both agents interpreted the spec consistently. Proceed to Step 5.

**Some tests FAIL** → This is the Agent Team's core value — mismatches reveal spec ambiguities. For each failure:

1. **eFrank investigates root cause** — read the failing test AND the corresponding implementation. Determine who is at fault:
   - **Agent A's fault (bad test)**: Test doesn't match the interface contract, wrong assertion, wrong selector, timing issue
   - **Agent B's fault (bad implementation)**: Implementation doesn't match the interface contract, missing endpoint, wrong response shape
   - **Contract ambiguity**: The interface contract was ambiguous and both agents made reasonable but different interpretations → update the contract in `acceptance/$ARGUMENTS.md`

2. **Delegate fix to the responsible agent** — use **SendMessage** to send the fix request to the same agent (Agent A or Agent B) that produced the faulty output. Include the specific failure details and what needs to change. Do NOT launch new agents — continue with the existing team.
   - If contract ambiguity → update the contract, then send fix instructions to both agents via SendMessage.

3. **Re-run tests** after each fix round. Repeat until all tests pass.

4. **eFrank as last resort** — if after 2 fix rounds agents still can't resolve a failure, eFrank writes the fix directly. This should be rare.

If a test is fundamentally flawed (wrong assumption, impossible precondition), go back to CHECKPOINT 1 — revise the acceptance spec with the developer, then relaunch the agent team.

## Step 5: Final Verification
> **Update `activeTask.md`**: Current step = Step 5

1. Ensure all dev environment services are running — restart via the startup script (see `devSetup.md`) if any went down during implementation
2. Run ALL tests (new + existing) to check for regressions
3. **Open the HTML test report** (e.g., `npx playwright show-report`) so the developer can review full results
4. If any existing test broke, fix it before proceeding
4. Update `acceptance/$ARGUMENTS.md`:
   - Mark all test IDs as passed: `- [x] API-001: PASS`
   - Add screenshot paths if generated

Show final summary to developer:
```
Feature: [name]
API Tests: X/X PASS
E2E Tests: X/X PASS
Regressions: None
Files created/modified: [list]
```

## Step 6: Update Jira (if configured)
> **Update `activeTask.md`**: Current step = Step 6

If a Jira ticket is associated with this feature:

1. Transition the ticket to **"Done"** (or the project's equivalent completion status)
2. Add a comment summarizing the implementation:
   - Test results (API: X/X, E2E: X/X)
   - Key files created/modified
   - Any notable decisions or trade-offs

## Step 7: Update Memory
> **Update `activeTask.md`**: Current step = Step 7

After feature is complete, run `/ef-context after-implement` to update the memory bank.

**After memory update completes, delete `memory-bank/activeTask.md`** — the workflow is done.

## Next Steps

Tell the developer:

1. **Commit wrapper repo** — If this is a multi-repo project, commit wrapper repo changes (`memory-bank/`, `acceptance/`) separately from sub-repo code changes. Both need to be committed.
2. **Review** — Open a new session and run `/ef-review` to check code quality before creating a PR.
3. **Next feature** — Check `memory-bank/progress.md` or the module plan for the next feature in the recommended development order.
4. **Worktree cleanup** — If you created a worktree in Step 0, after the PR is merged: `git worktree remove ../[worktree-name]`.
