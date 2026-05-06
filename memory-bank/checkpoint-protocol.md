# Checkpoint protocol

The full marker format, payload schema, and resume contract for approval
checkpoints are documented in [systemPatterns.md](systemPatterns.md) under
the section **"Approval marker format (locked, since #7)"**. This file is a
pointer — do not duplicate the contract here.

For quick reference, the marker is a single line:

```
<<<EF_APPROVAL_REQUEST>>>{json}<<<END_EF_APPROVAL_REQUEST>>>
```

The Workflow Runner (#7) parses the JSON between the sentinels and
populates `Run.pendingApproval`. The Approval Interface (#9) renders that
parsed payload — it does not re-parse the marker itself. Yolo mode
auto-approves and never enters `awaitingApproval`. Malformed JSON is
logged at warn level and treated as regular output (no pause).

The marker version is currently implicit (v1). Any change to the marker
sentinels, the payload schema, or the resume semantics requires bumping a
marker version in lockstep across the runner, the skill authoring docs,
and the renderer — per the rule in `systemPatterns.md`.
