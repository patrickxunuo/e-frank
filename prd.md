# 🧾 PRD — Desktop AI Ticket → PR Automation (MVP v2)

> **Naming.** The product surface is **Paperplane** (window title, installer, OS app entry). The repo + npm package name remain `e-frank` for now (a later, separately-decided rename can flip those).

## 1. 🎯 Goal

Build a desktop application that converts tickets (Jira / GitHub Issues) into working code and pull requests using Claude Code, with optional human approval.

## 2. 👤 Target User

Solo developer / power user, familiar with:

- Git workflows
- Jira or GitHub Issues
- Claude Code + custom skills (e.g. `ef-feature`)

## 3. 🧠 Core Concept

**Primary Unit:** Project Instance

A Project Instance defines *where* and *how* work happens.

- **Project** → provides context
- **Ticket** → provides work item
- **Task** → executes workflow

## 4. 🧩 Core Use Cases

### 4.1 Automated Flow

1. User marks ticket as "Ready for AI"
2. App detects ticket (polling)
3. App prepares repo + branch
4. App runs `ef-feature` workflow
5. User optionally approves steps
6. Code is generated
7. Commit + push
8. PR created (`feat` → `qa`)
9. Ticket updated with PR link

### 4.2 Manual Flow (important for MVP)

1. User selects a project
2. User manually selects a ticket
3. Click **Run**
4. Same workflow executes

## 5. 🔑 MVP Scope

### 5.1 Supported Integrations

- Jira (API polling)
- GitHub **or** Bitbucket (pick one first)
- Claude Code (local execution)
- Git CLI

> **Recommendation:** start with Jira + GitHub.

### 5.2 Project Instance Model

```yaml
name: Frontend App
repo:
  type: github
  localPath: /Users/patrick/projects/frontend
  baseBranch: qa
tickets:
  source: jira
  query: project = ABC AND status = "Ready for AI"
workflow:
  mode: interactive
  branchFormat: feat/{ticketKey}-{slug}
```

## 6. ⚙️ Features

### 6.1 Ticket Polling

- Interval: **5 minutes**
- Only pick tickets that:
  - match query
  - are not processed
  - are not currently running

### 6.2 Manual Ticket Selection

- Display tickets from Jira
- User can:
  - select any ticket
  - run workflow manually

### 6.3 Branch Creation

**Format:**

```
feat/{ticketKey}-{slug}
```

**Example:**

```
feat/ABC-123-login-validation
```

### 6.4 Claude Workflow Execution

**Command:**

```bash
claude "/ef-feature ABC-123"
```

**Modes:**

- `interactive` → requires approval
- `yolo` → auto-approve

### 6.5 Approval Interface

When Claude outputs a checkpoint like:

> "Shall I proceed?"

UI shows:

- ✅ Approve
- ❌ Reject
- ✏️ Modify input

### 6.6 Git Operations

1. Checkout base branch (`qa`)
2. Pull latest
3. Create feature branch
4. Add / commit / push changes

**Commit message format:**

```
feat(ABC-123): short description
```

### 6.7 PR Creation

- Create PR via API
- Source: `feat/*`
- Target: `qa`

### 6.8 Ticket Update

- Add comment: `PR created: <link>`
- Move status: `Ready for AI` → `In Review`

## 7. 🖥️ UI Design (MVP)

### 7.1 Project List

- List all project instances
- Click to enter project

### 7.2 Project Detail

- Show tickets
- Show status (`Ready` / `Running` / `Done`)
- Run button per ticket
- Toggle auto mode

### 7.3 Execution View

- Streaming Claude output
- Show current step
- Approval buttons when needed

## 8. 🏗️ Architecture

**Electron App:**

- UI: React
- Main process: Node.js

**Core modules:**

- Scheduler (polling)
- Workflow Runner
- Git Manager
- Claude Process Manager
- Local Config Storage

## 9. 🔄 Workflow Engine

Loop:

1. Poll tickets
2. Filter eligible tickets
3. Lock ticket
4. Prepare repo
5. Run Claude workflow
6. Wait for completion
7. Commit + push
8. Create PR
9. Update ticket

## 10. 🚨 Constraints / Non-goals

Not included in MVP:

- Multi-ticket concurrency
- CI/CD integration
- Multi-repo per project
- Advanced retry logic
- Team collaboration

## 11. ⚠️ Risks

| Risk                | Mitigation               |
| ------------------- | ------------------------ |
| Claude gets stuck   | Add timeout + cancel     |
| Bad code            | Default interactive mode |
| Git conflicts       | Always pull/rebase       |
| Duplicate execution | Ticket locking           |
| Wrong repo mapping  | Config validation        |

## 12. 📦 MVP Milestones

### Phase 1 (Day 1–2)

- Electron scaffold
- Run Claude command manually

### Phase 2 (Day 3–4)

- Jira polling
- Ticket list UI

### Phase 3 (Day 5–6)

- Workflow execution
- Streaming logs
- Approval UI

### Phase 4 (Day 7–8)

- Git commit + push
- PR creation
- Jira update

## 13. ✅ Success Criteria

MVP is successful if the user can:

1. Create a project
2. See tickets from Jira
3. Click **Run**
4. Approve steps
5. Get a PR created automatically
6. See the ticket updated with the PR link

## 14. 💡 Guiding Principles

- Keep automation **controlled, not blind**
- Prefer **interactive mode** first
- Optimize for **single-user workflow**
- Make failures **visible and debuggable**
