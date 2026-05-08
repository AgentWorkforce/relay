# @agent-relay/personas

Relay-maintained [AgentWorkforce](https://github.com/AgentWorkforce/workforce) personas.

This package is the canonical home for Relay-specific personas. Generic, internal
personas (especially `persona-maker`, which `agentworkforce create` depends on)
remain built into AgentWorkforce. Relay-oriented personas live here so their
prompts, docs, tests, release cadence, and domain assumptions stay close to the
Relay source they describe.

## Install

Install all personas from this pack:

```sh
agentworkforce install @agent-relay/personas
```

Install a single persona by id:

```sh
agentworkforce install @agent-relay/personas --persona relay-orchestrator
```

Pin a specific version:

```sh
agentworkforce install @agent-relay/personas@6.0.9
```

You can also install directly from a local checkout of this repo:

```sh
agentworkforce install ./packages/personas
agentworkforce install ./packages/personas --persona relay-orchestrator
```

## Personas

| Persona | Purpose |
| --- | --- |
| `relay-orchestrator` | Coordinates Relay implementation and operations work via a headless orchestrator that spawns larger models as needed. |
| `agent-relay-workflow` | Authors complete, runnable agent-relay workflow artifacts that follow the workflow skill contract and ship via GitHub primitives. |
| `agent-relay-e2e-conductor` | Drives full sage ↔ cloud ↔ Slack end-to-end validation across a real docker-compose stack. |
| `cloud-sandbox-infra` | Implements cloud sandbox provisioning, session management, credentials, executor wiring, and Daytona SDK integration. |
| `cloud-slack-proxy-guard` | Owns the canonical `POST /api/v1/proxy/slack` route — allow-listed methods, shared-secret auth, rate limits, audit log, stable response envelope. |
| `sage-slack-egress-migrator` | Migrates sage Slack egress off direct `NangoClient` and onto the `@relayfile/sdk` `ConnectionProvider` abstraction with no hardcoded `providerConfigKey` defaults. |
| `sage-proactive-rewirer` | Rewires sage's proactive Slack paths to resolve `connectionId` and `providerConfigKey` from stored state instead of guessing. |
| `opencode-workflow-specialist` | Diagnoses and repairs opencode-based agent-relay workflow failures across SDK, broker, cloud bootstrap, and CLI layers. |

## Persona pack metadata

Personas are surfaced to AgentWorkforce via the standard pack contract:

```json
{
  "name": "@agent-relay/personas",
  "agentworkforce": {
    "personas": "personas"
  }
}
```

`agentworkforce install` discovers persona JSON files inside the directory named
by `agentworkforce.personas`. Each file in `personas/` is a single persona, with
its file basename matching the persona `id`.

## Persona shape

Each persona JSON file has the following shape, matching the AgentWorkforce
persona schema:

```json
{
  "id": "string (matches filename basename)",
  "intent": "string",
  "tags": ["..."],
  "description": "string",
  "skills": [
    { "id": "string", "source": "url-or-pkg", "description": "string" }
  ],
  "tiers": {
    "best":        { "harness": "...", "model": "...", "systemPrompt": "...", "harnessSettings": { } },
    "best-value":  { "harness": "...", "model": "...", "systemPrompt": "...", "harnessSettings": { } },
    "minimum":     { "harness": "...", "model": "...", "systemPrompt": "...", "harnessSettings": { } }
  }
}
```

`skills` is optional. `tiers` is required and must contain at least one of
`best`, `best-value`, or `minimum`. Persona prompts are model-agnostic where
possible.

## Validation

Run the persona validator from the package directory:

```sh
npm --prefix packages/personas run validate
```

The validator checks every JSON file under `personas/`:

- file is valid JSON
- `id` is present and matches the file basename
- `intent`, `description`, and `tiers` are present
- at least one of the three known tiers (`best`, `best-value`, `minimum`) is set
- each tier has `harness`, `model`, and `systemPrompt`

## Versioning and publishing

This package versions in lockstep with the Relay monorepo and is published
alongside the rest of the `@agent-relay/*` packages by the root publish
workflow. Version bumps happen at the monorepo level — do not bump
`packages/personas/package.json` independently.

## Migration notes

Persona content was migrated from
[`AgentWorkforce/workforce/personas`](https://github.com/AgentWorkforce/workforce/tree/main/personas)
with stable persona ids and file basenames preserved. Relay-specific
operational guidance lives next to the Relay source it depends on; for context
on the migration see
[AgentWorkforce/workforce#38](https://github.com/AgentWorkforce/workforce/issues/38)
and
[AgentWorkforce/workforce#42](https://github.com/AgentWorkforce/workforce/issues/42).
