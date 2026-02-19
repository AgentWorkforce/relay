# Documentation Template

**Pattern:** handoff | **Timeout:** 50 minutes | **Channel:** swarm-documentation

## Overview

Documentation production workflow from research through publication. Sequential handoffs ensure content flows from research to writing to editing.

## Agents

| Agent | CLI | Role |
|-------|-----|------|
| lead | claude | Owns final editorial sign-off |
| researcher | codex | Collects technical context and source details |
| writer | codex | Drafts user-facing documentation |
| editor | claude | Edits for accuracy, clarity, and structure |

## Workflow Steps

```
gather-context → draft → edit → publish-summary
```

1. **gather-context** (researcher) — Collect source context and required updates
2. **draft** (writer) — Draft documentation based on gathered context
3. **edit** (editor) — Edit for technical accuracy and readability
4. **publish-summary** (lead) — Final summary of changes and open items

## Usage

```bash
agent-relay run --template documentation --task "Document the new API endpoints"
```

```typescript
import { TemplateRegistry, WorkflowRunner } from "@agent-relay/broker-sdk/workflows";

const registry = new TemplateRegistry();
const config = await registry.loadTemplate("documentation");
const runner = new WorkflowRunner();

await runner.execute(config, undefined, {
  task: "Document the new REST API endpoints for user management",
});
```

## Configuration

- **maxConcurrency:** 1 (sequential handoffs)
- **onError:** skip (documentation can continue with partial content)
- **errorStrategy:** continue
- **Barrier:** docs-ready (waits for gather-context, draft, edit)

## Verification Markers

- `CONTEXT_COMPLETE` — Research finished
- `DRAFT_COMPLETE` — Initial draft ready
- `EDIT_COMPLETE` — Editing finished
- `DONE` — Ready for publication
