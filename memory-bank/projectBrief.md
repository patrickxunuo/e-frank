# Project Brief

## Client / Project Name
**e-frank** — Desktop AI Ticket → PR Automation (MVP v2)

## Business Context
A desktop application that converts tickets (Jira / GitHub Issues) into working code and pull requests using Claude Code, with optional human approval. Targets solo developers / power users who already work with Git, Jira/GitHub Issues, and Claude Code custom skills (e.g. `ef-feature`).

The user wants to:
1. Mark a ticket as "Ready for AI" (or pick one manually)
2. Have the app prepare the repo + branch
3. Run a Claude workflow (`ef-feature`)
4. Optionally approve checkpoint steps
5. End with a PR pushed and the ticket updated with a link

## Core Requirements
- Project Instance model: a project ties together a repo, ticket source, and workflow config
- Jira polling (5 min interval) for tickets matching a JQL query
- Manual ticket selection alongside automated polling
- Claude Code execution as a child process with streaming output
- Approval UI for interactive checkpoints (Approve / Reject / Modify)
- Git operations: checkout base, pull, branch, add/commit/push
- PR creation via GitHub API (PR target: `qa`)
- Ticket update: add PR link comment, transition status

## Success Criteria
MVP succeeds if a user can:
1. Create a project instance
2. See tickets pulled from Jira
3. Click **Run** on a ticket
4. Approve checkpoint steps
5. Get a PR created automatically
6. See the ticket updated with the PR link

## Constraints
- **Single-user** workflow only — no multi-ticket concurrency in MVP
- **Interactive mode by default** — automation should be controlled, not blind
- **No CI/CD integration** in MVP
- **One repo per project** (no multi-repo support)
- **Cross-platform** desktop (macOS + Windows)

## Non-goals (MVP)
- Multi-ticket concurrency
- Multi-repo per project
- Advanced retry logic
- Team collaboration features
- CI/CD integration
