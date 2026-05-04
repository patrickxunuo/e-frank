---
name: ef-auto-test-backend
description: Automated backend testing — analyze source, generate test plan, write test script, execute and produce report
disable-model-invocation: true
argument-hint: [feature, module, command, method, or endpoint name]
---

# Auto Test Backend: $ARGUMENTS

Automated workflow for integration-testing backend logic against real infrastructure. Produces a test plan, executable test script, and markdown report. Follow every step in order.

**Scope**: This skill tests **any backend logic** — a single command, an API endpoint, a service method, a module with multiple endpoints, or an entire feature spanning several components. The target can be narrow (one function) or broad (a feature covering multiple routes and background jobs). It sets up test data, triggers the target action(s), then verifies state changes. All tests run against real infrastructure — never mocked. The project's tech stack (from `memory-bank/techContext.md`) determines the specific tools and connection methods used.

## Active Task Tracking

**At the start of each step**, update `memory-bank/activeTask.md` with current progress. This file is **local per-developer** — ensure `memory-bank/activeTask.md` is in `.gitignore` (add it if missing).

Format:
```markdown
# Active Task
- Skill: /ef-auto-test-backend
- Skill file: .claude/skills/ef-auto-test-backend/SKILL.md
- Target: $ARGUMENTS
- Current step: [Step N: name]
- Waiting for: [developer / nothing]

## Completed
- [x] Step 1: Context read
- [x] Step 2: Source analysis
...

## Key Artifacts
- Test plan: [path]
- Test script: [path]
- Test report: [path]
- Source files: [paths]
```

**When the workflow completes** (Step 8 done), delete `memory-bank/activeTask.md`.

## Step 1: Understand Context
> **Update `activeTask.md`**: Current step = Step 1

0. **Guard**: If `memory-bank/index.md` does not exist, STOP — tell the developer: "Memory bank not initialized. Run `/ef-context` first, then come back to `/ef-auto-test-backend`."
1. Read `memory-bank/index.md` — find all relevant context files
2. Read `memory-bank/techContext.md` — tech stack, data store connections, framework
3. Read `memory-bank/systemPatterns.md` — code conventions
4. Read `memory-bank/devSetup.md` if it exists — how to run the backend, connection details
5. If $ARGUMENTS references a Jira ticket, look it up via MCP tools
6. **Determine infrastructure connection**: Check which data store(s) the local backend connects to (database, cache, message queue, etc.). Read connection details from `devSetup.md` and the application's config files. The test script MUST connect to the **same data store** the backend API uses. Mismatched connections (e.g., inserting into dev DB while API reads from QA DB) will cause all API-dependent tests to fail.

## Step 2: Analyze Source Code
> **Update `activeTask.md`**: Current step = Step 2

Locate and thoroughly read the source code for $ARGUMENTS. The target may be a single entry point or span multiple files — adapt your analysis accordingly.

1. **Identify all relevant source files**:
   - For a **command/method**: find the specific handler, controller, or service class
   - For an **endpoint**: find the route definition, controller, middleware, and service layer
   - For a **feature/module**: find all related controllers, services, models, jobs, and listeners that make up the feature
2. **Trace every code path** from entry to exit (repeat for each entry point):
   - Entry point (handle/execute method, route handler)
   - Lock acquisition (Redis, file, database locks)
   - Data fetching (what queries, what tables/collections, what conditions)
   - Processing logic (loops, conditionals, state machines)
   - Data mutation (writes, updates, deletes — what tables/collections, what conditions)
   - Cross-component calls (service calls, event dispatches, queue jobs triggered)
   - Error handling (try-catch, early returns, logging)
   - Exit (lock release, completion logging)
3. **Map each branch to a testable scenario** — every `if`, `return`, `continue`, `catch` is a potential test case
4. **Identify non-obvious behavior** — e.g., "continues after failure", "marks SUCCEED despite partial fix", "deletes record instead of updating"
5. **Note the data stores involved** — list every table/collection read or written, with key columns/fields
6. **Check for scheduling/queue behavior** — batch size limits, pagination, lock TTL
7. **Map interactions** (for features/modules) — how do the components call each other? What order? What side effects cascade between them?

Present findings to the developer:
```
Target: [name]
Type: [command | endpoint | method | feature | module]
Source files: [list of paths]
Data stores involved: [list]
Code paths found: [count]
Notable behavior: [list non-obvious findings]
```

## Step 3: Generate Test Plan
> **Update `activeTask.md`**: Current step = Step 3

Create file `docs/<feature>/<feature>-test-plan.md` with this structure:

### Test Plan Structure

```markdown
# Test Plan: [Target Name]

## Context
[1-3 paragraphs: what the target does, critical code behavior discovered, source file paths]

## Test Environment Setup
### Config
[Environment variables needed]

### Cleanup script
[Commands or queries to reset test data before each test, using safe ID ranges]

### Trigger method(s)
[How to trigger the target — may be one or more of: CLI command, API endpoint(s), queue dispatch, scheduler invocation. For features/modules, list each trigger separately.]

### Log monitoring
[Tail command for relevant logs]

## Test Cases
### TC-XX: [Name]
**What**: [One-line scenario description]
**Setup**: [Data insertion statements (SQL, API calls, seed scripts, etc.)]
**Expected**: [Table of checks with verification query/command + expected value]

## Recommended Execution Order
[Numbered list: sanity checks first, then core, then edge, then performance/concurrency]

## Potential Issues Found
[Behavioral observations discovered during code analysis]
```

### Test Case Design Rules

1. **Map scenarios from code paths** (Step 2), organized by category:
   - **Happy path**: Standard successful operation
   - **No-op / skip conditions**: Record deleted, no conflict, already processed
   - **Edge cases**: Boundary values (0, MAX_INT), empty sets, duplicates
   - **Concurrency**: Lock contention, optimistic lock failure, race conditions
   - **Batch processing**: Single item, multiple items, exceeding batch size limit
   - **Mixed scenarios**: Multiple different outcomes in one run (integration test)
   - **Cross-component flows** (for features/modules): Multi-step sequences that chain triggers (e.g., create → process → verify), testing the full workflow end-to-end

2. **Use safe ID ranges** to avoid conflicts with real data:
   - Pick ranges far from production data
   - Document the ranges in the test plan header

3. **Each test case must be self-contained**:
   - Full setup data (no dependencies on other test cases)
   - Full expected results with exact verification queries/commands
   - Cleanup handled by a shared cleanup function

4. **Mark manual-only tests** (requiring code changes, cache access, multiple terminals) as candidates for SKIP with documented manual steps

## CHECKPOINT 1
> **Update `activeTask.md`**: Current step = CHECKPOINT 1, Waiting for = developer

**STOP HERE.** Show the test plan to the developer.
Say: "Here is the test plan for [$ARGUMENTS] with [N] test cases covering [list categories]. Review the scenarios — you can add, modify, or remove test cases. Confirm when ready and I'll generate the test script."

Wait for developer confirmation before proceeding.

## Step 4: Determine Infrastructure Connection
> **Update `activeTask.md`**: Current step = Step 4

Before writing the test script, confirm the infrastructure connection:

1. Read `memory-bank/devSetup.md` and `memory-bank/techContext.md` for connection details
2. Check the application's configuration files (`.env`, config files, docker-compose, etc.) for data store host, port, credentials
3. **Critical**: Verify the test script connects to the **same data store instance** the backend API uses — if they point to different instances, all API-triggered tests will produce wrong results
4. If using network tunnels (e.g., SSH port forwarding to a remote database), the script must connect through the same tunnel
5. Handle credentials securely — use environment variables rather than inline passwords in the script

Document the connection details in the script header.

## Step 5: Write Test Script
> **Update `activeTask.md`**: Current step = Step 5

Create file `docs/<feature>/run-<feature>-tests.sh`:

### Script Structure

```bash
#!/bin/bash
# =============================================================================
# Automated Test Runner for [Target Name]
# Based on: <feature>-test-plan.md
# Date: [auto]
# Tech stack: [from techContext.md]
# =============================================================================

# --- Connection ---
# Configure based on the project's tech stack (see techContext.md)
DB_CMD="<database-cli-command with connection flags>"  # e.g., mysql, psql, mongosh, sqlite3
API_URL="<application-endpoint>"
REPORT_FILE="<path-to-report.md>"

PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0

# --- Helper Functions ---
cleanup_all() { ... }      # Remove test data using safe ID ranges
trigger() { ... }           # Trigger the target: curl, CLI invocation, queue dispatch, etc.
                            # For features/modules with multiple triggers, create named variants:
                            # trigger_create(), trigger_update(), trigger_process(), etc.
query() { ... }             # Run a read query against the data store
insert() { ... }            # Insert test data (handle constraints as needed)
assert_eq() { ... }         # Compare actual vs expected, trim whitespace

# --- Test Cases ---
# One block per TC, following the pattern:
# 1. echo test name
# 2. cleanup_all
# 3. insert setup data
# 4. trigger (or named variant)
# 5. assert results
# 6. update PASS/FAIL count

# --- Skipped Tests ---
# Document reason and manual steps

# --- Final Cleanup ---
cleanup_all

# --- Generate Report ---
# Write markdown report to $REPORT_FILE using heredoc
```

### Script Rules

1. **Respect data store constraints**: If the data store has strict mode or schema constraints, handle them in the insert helper (e.g., relaxing SQL mode, handling NOT NULL defaults, adjusting type coercions)
2. **Provide explicit values** for all required fields — don't rely on defaults that may not exist
3. **Verify actual column/field types** — test plan may assume one type but the actual schema could differ
4. **Each test case**: cleanup -> insert -> trigger -> assert -> tally
5. **Report generation**: Embed in the script using heredoc, interpolating status variables
6. **The report must include**:
   - Test information table (date, target, data store, ID ranges)
   - Summary table (total, passed, failed, skipped)
   - Per-test section with objective, workflow, and checks table
   - Skipped tests with manual steps
   - Known issues / observations section
7. **Tech-specific details**: Consult `memory-bank/techContext.md` for the exact CLI tools, connection flags, and query syntax for this project's data store

### Multi-Repo Check
Check `memory-bank/techContext.md` for the project's repository structure:
- **Single repo**: Create all artifacts in the current project's `docs/` directory
- **Multi-repo**: Place test artifacts in the repo where the backend code lives. If the target repo is not the current working directory, tell the developer which repo needs the files and provide the content.

## CHECKPOINT 2
> **Update `activeTask.md`**: Current step = CHECKPOINT 2, Waiting for = developer

**STOP HERE.** Show the test script to the developer.
Say: "Test script is ready with [N] automated tests and [M] skipped (manual). The script connects to [data store info]. Confirm to execute."

Wait for developer confirmation before proceeding.

## Step 6: Execute Tests
> **Update `activeTask.md`**: Current step = Step 6

### Ensure Dev Environment is Running
Before running tests:
1. Check `memory-bank/devSetup.md` for the startup script filename, or look for `dev-start.*` at project root
2. If found → run the script
3. If not → run `/ef-dev explore` first
4. If services are already running — skip startup

### Pre-flight Checks
1. Verify the backend API is running (check the configured endpoint)
2. Verify data store connectivity (the connection in the script can reach the data store)
3. If network tunnels are required, verify they are active

### Run
```bash
cd docs/<feature> && bash run-<feature>-tests.sh
```

### Handle Results
- **All PASS**: Proceed to Step 7
- **Some FAIL**: Investigate each failure:
  - **Script bug** (wrong query, wrong expected value, timing issue) → fix the script, re-run
  - **Real application bug** → document in the report's "Known Issues", do NOT change the expected value to match buggy behavior
  - **Environment issue** (data store not connected, API down, wrong instance) → fix environment, re-run
- **Re-run after fixes** until results are stable

## Step 7: Verify Report
> **Update `activeTask.md`**: Current step = Step 7

1. Read the generated report file
2. Verify:
   - Data store info is correct (not showing wrong host/port)
   - All test statuses match the actual run
   - Summary counts are accurate
   - Known issues section reflects actual findings
3. Fix any discrepancies in the report template within the script

Show summary to developer:
```
Target: [command/feature name]
Test Plan: [path]
Test Script: [path]
Test Report: [path]

Results: X PASS / Y FAIL / Z SKIP out of N total
Known Issues: [count]
```

## Step 8: Update Memory
> **Update `activeTask.md`**: Current step = Step 8

Run `/ef-context after-implement` to update memory bank — record:
- The testing pattern used (data stores, ID ranges, trigger method)
- Any schema discoveries (column/field types, required fields, constraint modes)
- Known behavioral issues found in the target

**After memory update completes, delete `memory-bank/activeTask.md`** — the workflow is done.

## File Organization

```
docs/<feature>/
  +-- <feature>-test-plan.md          # Step 3 output
  +-- run-<feature>-tests.sh          # Step 5 output
  +-- <feature>-test-report.md        # Step 6 output (auto-generated)
```

## Next Steps

Tell the developer:

1. **Review report** — Check the generated test report for any unexpected results.
2. **Re-run anytime** — `bash docs/<feature>/run-<feature>-tests.sh` to re-execute and regenerate the report.
3. **Manual tests** — Follow the documented manual steps for SKIPPED test cases (lock contention, race conditions, large batches).
4. **Commit wrapper repo** — If this is a multi-repo project, commit wrapper repo changes (`memory-bank/`) separately from sub-repo code changes. Both need to be committed.
5. **Commit artifacts** — Commit the test plan, script, and report together in the relevant repo.
6. **CI integration** — The script can be added to CI pipelines for regression testing.
7. **Worktree cleanup** — If you used a worktree, after the task is complete: `git worktree remove ../[worktree-name]`.
