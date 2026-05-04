---
name: ef-pda-auto-test
description: PDA Android app E2E testing — Maestro UI automation + backend DB verification with screenshots
disable-model-invocation: true
argument-hint: [test-scenario-description or flow-name]
---

# PDA Auto Test: $ARGUMENTS

Automated full-stack E2E testing for a PDA Android app. Drives the real UI via Maestro, triggers backend API calls, and verifies database state changes. Captures screenshots at each key step. Follow every step in order.

**Scope**: Three layers — **UI Automation** (Maestro on emulator/device), **Backend API** (PDA's real API hits QA backend), **Database Verification** (confirms state changes in QA DB). Test harness lives in `<pda-repo>/e2e/`, results in `<wrapper-repo>/e2e-test-results/`.

## Active Task Tracking

**At the start of each step**, update `memory-bank/activeTask.md` with current progress. This file is **local per-developer** — ensure `memory-bank/activeTask.md` is in `.gitignore` (add it if missing).

Format:
```markdown
# Active Task
- Skill: /ef-pda-auto-test
- Skill file: .claude/skills/ef-pda-auto-test/SKILL.md
- Target: $ARGUMENTS
- Current step: [Step N: name]
- Waiting for: [developer / nothing]

## Completed
- [x] Step 1: Context read
- [x] Step 2: Environment verification
- [x] Step 3: Scenario analysis
...

## Key Artifacts
- Maestro flow: [path]
- Test harness script: [path]
- Runner script: [path]
- Screenshots: [directory]
- Test report: [path]
- Source files: [paths]
```

**When the workflow completes** (Step 8 done), delete `memory-bank/activeTask.md`.

## Step 1: Understand Context
> **Update `activeTask.md`**: Current step = Step 1

0. **Guard**: If `memory-bank/index.md` does not exist, STOP — tell the developer: "Memory bank not initialized. Run `/ef-context` first, then come back to `/ef-pda-auto-test`."
1. Read `memory-bank/index.md` — find all relevant context files
2. Read `memory-bank/projectBrief.md` — business context
3. Read `memory-bank/techContext.md` — PDA tech stack, API endpoints, data store connections
4. Read `memory-bank/systemPatterns.md` — code conventions
5. Read `memory-bank/devSetup.md` if it exists — connection details, credentials, environment setup
6. Read any topic-specific memory files relevant to this test scenario (listed in index.md)
7. If $ARGUMENTS references a Jira ticket, look it up via MCP tools
8. If Confluence is configured in `techContext.md`, search for related design docs

## Step 2: Verify Environment
> **Update `activeTask.md`**: Current step = Step 2

### 2.1 Verify Tools
Check and report status for each:
- **ADB**: `local.properties` → `sdk.dir` → verify `platform-tools/adb.exe` exists
- **Java 17+**: `java -version` — fallback to JetBrains bundled JDK
- **Maestro**: `maestro --version` (with correct JAVA_HOME)
- **Device**: `adb devices` — at least one `device`
- **APK**: `adb shell pm list packages | grep dispatch`
- **DB**: Test connection (port, credentials from devSetup.md)
- **QA API**: `curl -s -o /dev/null -w "%{http_code}" <qa-api-url>/`

### 2.2 Build Environment Config
From project files, determine: `ANDROID_HOME`, `JAVA_HOME`, `MAESTRO_CLI_NO_ANALYTICS=1`, app package ID.

### 2.3 Verify Credentials
Test login API directly. If it fails, STOP and ask developer for valid credentials.

### 2.4 Verify Infrastructure Connection
Confirm the test harness connects to the **same data store** the QA API uses. Mismatched connections cause all verification tests to fail. Read connection details from `devSetup.md` and app config files.

Report full environment status. Fix issues before proceeding.

## Step 3: Analyze the Test Scenario
> **Update `activeTask.md`**: Current step = Step 3

Parse `$ARGUMENTS` to understand the PDA flow:

1. **Identify the flow** — read PDA source, map screens/features/navigation paths and home screen entry points
2. **Identify backend endpoints** — trace ViewModel → repository → Retrofit API interface; note request/response format
3. **Identify database tables** — which tables are read/written during the flow
4. **Plan test steps** as a numbered list:
   ```
   1. [Seed] Insert test data in DB (if needed)
   2. [UI] Login as <role>
   3. [UI] Navigate to <feature>
   4. [UI] Perform <action> — screenshot
   5. [UI] Verify UI shows <expected> — screenshot
   6. [Verify] Check DB: <table>.<column> = <expected>
   7. [Cleanup] Remove test data
   ```

Present findings to the developer:
```
Target: [scenario name]
Source files: [list of PDA source paths]
Data stores involved: [list]
UI steps: [count]
DB verifications: [count]
Notable behavior: [list non-obvious findings]
```

## CHECKPOINT 1
> **Update `activeTask.md`**: Current step = CHECKPOINT 1, Waiting for = developer

**STOP HERE.** Show the test plan to the developer.
Say: "Here is the E2E test plan for [$ARGUMENTS] with [N] UI steps and [M] DB verifications. The flow will: [brief summary]. Screenshots will be saved at each key step. Confirm when ready and I'll generate the Maestro flow."

Wait for developer confirmation before proceeding.

## Step 4: Create Maestro Flow & Test Harness
> **Update `activeTask.md`**: Current step = Step 4

### 4.1 Maestro Flow
Create `<pda-repo>/e2e/flows/<flow-name>.yaml`. **Authoring rules** (check memory-bank for project-specific discoveries):

1. **Login fields**: Compose `BasicTextField` → `EditText` with empty text. Use coordinate taps via `maestro hierarchy`.
2. **Scanner popup**: Dismiss "Start scanning" popup BEFORE interacting when `clearState: true`.
3. **Waits**: `extendedWaitUntil` + `visible`. Never use `swipe` for timing.
4. **Back nav**: Count exact depth. Safety: `tapOn: "Cancel" optional: true` to catch logout dialog.
5. **Text matching**: Home cards may be multiline (`"Manual\nBundling"`). Use `index: 0` for duplicates.
6. **Screenshots**: `<NN>_<descriptive_name>` format, zero-padded.
7. **Variables**: `-e KEY=VALUE`. Required: `APP_ID`, `USERNAME`, `PASSWORD`, `SCREENSHOT_DIR`.
8. **Multi-phase**: Split flows + shell orchestrator for dynamic data between phases.

### 4.2 Test Harness (if DB verification needed)
Create `<pda-repo>/e2e/tests/<test-name>.sh` using `e2e/lib/` shared libraries. Follows **4-phase pattern**: `seed()` → `run_ui()` → `verify()` → `cleanup()`. Use safe ID ranges, connect to same DB as QA API (Step 2.4), delay before async verification, cleanup always runs. Create `e2e/lib/` if it doesn't exist.

### 4.3 Runner Script
Create `<pda-repo>/e2e/run_<test-name>.sh` — sets env vars and executes. Use `--device <id>` for Maestro 2.x.

### Multi-Repo Check
Check `techContext.md` repo structure. Multi-repo: test artifacts → PDA repo, screenshots/reports → wrapper repo `e2e-test-results/`. Tell developer which repos need commits.

## CHECKPOINT 2
> **Update `activeTask.md`**: Current step = CHECKPOINT 2, Waiting for = developer

**STOP HERE.** Show the generated files to the developer.
Say: "Test artifacts ready:
- Maestro flow: `<path>` ([N] steps, [M] screenshots)
- Test harness: `<path>` (seed/verify/cleanup)
- Runner script: `<path>`

Confirm to execute the test. Make sure [prerequisites: SSH tunnel, emulator, etc.] are running."

Wait for developer confirmation before proceeding.

## Step 5: Execute Test
> **Update `activeTask.md`**: Current step = Step 5

**Pre-flight**: device connected, app installed, DB tunnel active, QA API reachable, credentials valid.

**Run**: Clean previous screenshots, then:
- UI-only: `bash e2e/run_<test-name>.sh`
- Full-stack: `bash e2e/run_test.sh e2e/tests/<test-name>.sh`

**Handle failures**:
- Maestro: check `~/.maestro/tests/<timestamp>/` debug screenshot, read it, fix YAML. Common: credentials, Compose field matching, popups, Back depth, swipe dialogs.
- DB verification: check screenshots for API trigger, adjust timing, verify expected values against backend logic.

**Iterate** until pass or all failures documented.

## Step 6: Collect Results & Generate Report
> **Update `activeTask.md`**: Current step = Step 6

1. Verify screenshots captured expected state
2. Create `<wrapper-repo>/e2e-test-results/<test-name>-report.md`: test info, step-by-step results with screenshot refs, DB verification results, summary (total/passed/failed/screenshots), issues found

Show summary to developer:
```
Test: [name]
Flow: [path]
Screenshots: [directory] ([count] files)
Report: [path]

Result: X/Y steps passed
Issues: [count] found
```

## Step 7: Refine (if needed)
> **Update `activeTask.md`**: Current step = Step 7

Failed steps: show failure screenshot, explain, propose fix, re-run from Step 5 after approval.
New scenarios: go back to Step 3 — don't modify existing passing flows.

## Step 8: Update Memory
> **Update `activeTask.md`**: Current step = Step 8

Run `/ef-context after-implement` to update memory bank — record:
- PDA features tested and their UI navigation paths
- UI label discoveries (role names, button text, screen titles)
- QA API endpoint patterns verified
- Bugs or behavioral issues found
- Environment setup details

**After memory update completes, delete `memory-bank/activeTask.md`.**

## File Organization

```
<pda-repo>/e2e/
├── lib/          # Shared: config.sh, db.sh, assert.sh, maestro.sh
├── flows/        # Maestro YAML flows
├── tests/        # Full-stack test harnesses
├── run_test.sh   # Generic runner
└── run_<test>.sh # Per-test runners

<wrapper-repo>/e2e-test-results/
├── <NN>_<step>.png        # Screenshots
└── <test>-report.md       # Reports
```

## Next Steps

Tell the developer:

1. **Review screenshots** in the results directory.
2. **Re-run anytime** — `bash e2e/run_<test-name>.sh`.
3. **Add more flows** — copy an existing YAML flow as template.
4. **Commit wrapper repo** — commit `memory-bank/` and `e2e-test-results/` separately from PDA repo code.
5. **Commit artifacts** — Maestro flows and harnesses to PDA repo, screenshots and reports to wrapper repo.
6. **Worktree cleanup** — after task complete: `git worktree remove ../[worktree-name]`.
