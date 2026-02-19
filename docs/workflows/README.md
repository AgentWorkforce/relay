# Agent Relay Workflows

Orchestrate multi-agent workflows using YAML, TypeScript, or Python. This directory contains documentation for available swarm patterns and built-in workflow templates.

## Quick Start

```bash
# Run a YAML workflow
agent-relay run workflow.yaml

# Run a built-in template
agent-relay run --template feature-dev --task "Add user authentication"
```

## Swarm Patterns

Swarm patterns define how agents coordinate and execute tasks. Choose the pattern that best fits your workflow structure.

| Pattern | Description | Best For |
|---------|-------------|----------|
| [dag](patterns/dag.md) | Directed acyclic graph with dependency edges | Complex workflows with interdependent steps |
| [fan-out](patterns/fan-out.md) | All agents run in parallel | Independent parallel reviews or assessments |
| [pipeline](patterns/pipeline.md) | Sequential step chaining | Linear processes with strict ordering |
| [hub-spoke](patterns/hub-spoke.md) | Central hub coordinates spoke agents | Coordinated feature development |
| [consensus](patterns/consensus.md) | Agents vote on decisions | Democratic decision-making |
| [mesh](patterns/mesh.md) | Full communication graph | Collaborative problem-solving |
| [handoff](patterns/handoff.md) | Sequential agent handoffs | Document or artifact production |
| [cascade](patterns/cascade.md) | Waterfall with phase gates | Gated release processes |
| [debate](patterns/debate.md) | Agents propose and counter-argue | Design exploration, trade-off analysis |
| [hierarchical](patterns/hierarchical.md) | Multi-level reporting structure | Large refactors, organizational workflows |

## Built-in Templates

Pre-configured workflows for common development tasks. Each template defines agents, steps, and coordination settings.

| Template | Pattern | Description |
|----------|---------|-------------|
| [feature-dev](templates/feature-dev.md) | hub-spoke | Plan, implement, review, and finalize a feature |
| [bug-fix](templates/bug-fix.md) | hub-spoke | Investigate, patch, validate, and document a bug fix |
| [code-review](templates/code-review.md) | fan-out | Parallel multi-reviewer assessment with consolidated findings |
| [security-audit](templates/security-audit.md) | pipeline | Scan, triage, remediate, and verify security issues |
| [refactor](templates/refactor.md) | hierarchical | Analyze, plan, execute, and validate a refactor |
| [documentation](templates/documentation.md) | handoff | Research, draft, review, and publish documentation |

## Using Templates

```typescript
import { TemplateRegistry } from "@agent-relay/broker-sdk/workflows";

const registry = new TemplateRegistry();

// List available templates
const templates = await registry.listTemplates();

// Run a template
const config = await registry.loadTemplate("feature-dev");
const runner = new WorkflowRunner();
await runner.execute(config, undefined, {
  task: "Add WebSocket support to the API",
});
```

## Creating Custom Workflows

See the [Workflow YAML Reference](../../packages/broker-sdk/src/workflows/README.md) for full configuration options.
