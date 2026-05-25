# Harnessed Direct-Model Execution — Implementation Spec

**Covers**: A fourth workflow execution mode — in-process agent loop against a direct model API, running inside the cloud sandbox, without shelling out to a CLI binary.
**Status**: Draft
**Date**: 2026-04-09
**Author**: Design session (human + Claude)

---

## 1. Context

### What exists today

Workflows in relay execute through three paths, selected by an agent's `cli` field:

1. **PTY/CLI** — spawns `claude`, `codex`, `gemini`, etc. as interactive subprocesses via the Rust broker. Full harness, file edits, MCP, permission prompts. Heavy. Requires the CLI binary to be installed wherever the workflow runs.
2. **Cloud sandbox** — the relay `agent-relay cloud run` command tars the workspace, uploads to S3, and the AgentWorkforce cloud service provisions a Daytona sandbox (`AgentWorkforce/cloud/sandbox/Dockerfile`) pre-loaded with claude + codex + `@agent-relay/sdk`. Inside the sandbox, the same `WorkflowRunner` executes steps — usually by spawning the same CLI binaries locally in the container. This is still "Path 1 but remote": the harness is a CLI binary, just one running in a container.
3. **`cli: 'api'`** — `packages/sdk/src/workflows/api-executor.ts` calls LLM provider APIs directly via `fetch()`. Recently extended to support OpenRouter with a BYOK-plus-managed-fallback key resolution chain. **No tools. No agent loop. Pure text in, text out.** Useful for summarization, classification, and other stateless generation tasks inside a larger workflow, but useless for anything that needs to _do_ things.

### The gap

Consumer-facing products built on relay — Electron apps, hosted tools, any context where shipping a full Claude Code binary is impractical — need a workflow path that:

- Runs as a **library**, not a subprocess of a CLI binary
- Supports a **multi-turn tool-use loop** (read/write files, HTTP fetch, MCP tools so relaycast messaging keeps working)
- Works with **multiple model providers** (Anthropic first, OpenAI/Gemini/OpenRouter later via existing fallback chain)
- Integrates cleanly with the existing `WorkflowRunner` step model — specifically slotting into the same place `executeApiStep` already lives
- Respects **BYOK** (user's own key wins; falls back to relay-managed OpenRouter key billed to our account; see `packages/sdk/src/workflows/api-executor.ts:130`)

This is the "fourth mode" — `cli: 'harness'` (working name). A harnessed direct-model execution path.

### Why not just use `@anthropic-ai/sdk` low-level HTTP client?

Because the low-level `@anthropic-ai/sdk` is what `cli: 'api'` already uses via `fetch()`. Upgrading that call path from `fetch` to `new Anthropic({ apiKey }).messages.create()` is a lateral swap — cleaner types, but no new capability. The debate on 2026-04-09 (see `.relay/debates/direct-model-harness/verdict.md`) recommended "Anthropic SDK" but conflated the two Anthropic packages. The _actual_ harness is a separate product:

| Package                          | What it is                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/sdk`              | Low-level HTTP client for the Messages API. Beta `tool_runner` exists but lacks MCP, hooks, sub-agents, permission flow.                                                     |
| `@anthropic-ai/claude-agent-sdk` | **Claude Agent SDK** — the harness that powers Claude Code itself. Full tool loop, MCP integration, hooks, sub-agent support, system prompt management, permission handling. |

This spec targets the **Claude Agent SDK**, not the low-level SDK.

---

## 2. Goals and non-goals

### Goals

1. Add `executeHarnessedStep()` alongside `executeApiStep()` in `api-executor.ts`, with the same function shape so the runner wiring is a one-line change.
2. Use `@anthropic-ai/claude-agent-sdk` to provide a multi-turn tool-use loop for Anthropic models.
3. Load the SDK via **dynamic import** so the peer dep is optional — local dev machines and consumer apps not using harnessed mode never pay for it.
4. Install the concrete dep in **exactly one place**: the cloud sandbox Dockerfile (`AgentWorkforce/cloud/sandbox/Dockerfile`).
5. Plug relaycast MCP tools into the harness via the Agent SDK's MCP client, so harnessed agents can message other agents on the relay channel.
6. Preserve the existing BYOK + OpenRouter fallback chain from `executeApiStep` — a harnessed step with no Anthropic key falls back to the single-shot `executeApiStep` path via OpenRouter instead of failing.
7. Add a unit test that verifies the dynamic-import path fails cleanly with a useful error message when the peer dep is missing.

### Non-goals

1. **Multi-provider harness parity.** This spec is Anthropic-only. Harnessed mode for OpenAI / Gemini is future work. The escape valve is: if the model isn't Anthropic, fall through to `executeApiStep` (single-shot) so workflows still work, just without the tool loop.
2. **Local CLI installation of the harness.** Local `agent-relay run` continues to use CLI binaries. The peer dep is not added to `relay/package.json` or any local dev install path.
3. **Replacing `cli: 'api'`.** The one-shot mode is still useful for stateless generation tasks and remains the default for `cli: 'api'`. Harnessed mode is opt-in via a new `cli: 'harness'` value.
4. **Replacing CLI-based workflow steps.** `cli: 'claude'`, `cli: 'codex'` etc. are still the recommended path for workflow steps that need the full Claude Code / Codex experience. This is an additive fourth mode, not a migration.
5. **Sandboxing or permission prompts in harnessed mode.** The Claude Agent SDK handles its own permission model. Relay will run harnessed steps with permissions wide open inside the sandbox, matching how `claude --dangerously-skip-permissions` runs today.
6. **Streaming UI for harnessed steps.** Output reporting uses the existing step-output reporter (whatever the runner currently does for `executeApiStep`). Streaming token-by-token to the user can be added later if needed.

---

## 3. Architecture

### Why peer dep, not regular dep

`packages/sdk/package.json` already declares these as `peerDependencies`:

```
@anthropic-ai/claude-agent-sdk    ← already here
@google/adk
@langchain/langgraph
@openai/agents
ai
crewai
@mariozechner/pi-coding-agent
```

This is an intentional architectural decision that predates this spec: **the SDK defines the integration contract; consumers bring the harness they want.** Every harness framework is listed as a peer dep. This spec doesn't invent a new pattern — it uses the one that's already there.

The reason to respect this: someone using `@agent-relay/sdk` only for `AgentRelayClient` (talking to a remote broker over HTTP from a lightweight client) should not download LangChain, CrewAI, Google ADK, and the Claude Agent SDK just to open a WebSocket. Peer deps let the sdk be both a fat orchestrator library AND a thin client library depending on what the consumer actually uses.

### Where the concrete install lives

One place only:

```dockerfile
# AgentWorkforce/cloud/sandbox/Dockerfile, line ~26
WORKDIR /home/daytona
RUN npm init -y && \
    npm install \
      @aws-sdk/client-s3 \
      @aws-sdk/client-sts \
      @agent-relay/sdk \
      @agent-relay/config \
      tar \
      ignore \
      @anthropic-ai/claude-agent-sdk \   # ← add this
    && npm cache clean --force
```

Why here and nowhere else:

| Location                                             | Harness needed?        | Reason                                                                                      |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| Local `agent-relay` CLI                              | No                     | Local workflows use CLI binaries (`claude`, `codex`). The harness is the binary itself.     |
| `relay/packages/sdk`                                 | No (peer dep only)     | Library contract, not runtime                                                               |
| `relay/packages/cloud` (client)                      | No                     | Thin HTTP client that POSTs workflow runs to the cloud API — executes nothing               |
| `AgentWorkforce/cloud` (sibling repo, cloud service) | No                     | Provisions sandboxes, doesn't execute workflow steps itself                                 |
| **`AgentWorkforce/cloud/sandbox/Dockerfile`**        | **Yes**                | The Daytona container where `WorkflowRunner` actually runs workflow steps                   |
| Consumer Electron app                                | Yes (consumer-managed) | If a consumer app embeds harnessed mode, it installs the peer dep in its own `package.json` |

### Dynamic import in api-executor.ts

```ts
// packages/sdk/src/workflows/api-executor.ts

async function loadClaudeAgentSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    throw new Error(
      'Harnessed direct-model mode requires @anthropic-ai/claude-agent-sdk, ' +
        'which is a peer dependency. This is normally provided by the cloud ' +
        'sandbox. If you are running a harnessed workflow locally, install it: ' +
        '\n  npm install @anthropic-ai/claude-agent-sdk' +
        '\nOr change the step to cli: "api" for one-shot mode (no tool loop).'
    );
  }
}
```

**Why dynamic and not static:**

A static `import '@anthropic-ai/claude-agent-sdk'` at the top of `api-executor.ts` would fail at module-load time on any machine that doesn't have the peer dep installed. That means a local dev running `agent-relay run workflows/some-cli-workflow.ts` would crash at startup because a code path they never use has a missing import. Dynamic import defers the resolution until the moment the harnessed path is actually hit, which means zero cost for every other workflow run.

### The `executeHarnessedStep` shape

```ts
export interface HarnessedStepOptions extends ApiExecutorOptions {
  /** MCP tool schemas the harnessed agent can call */
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  /** Callback to dispatch a tool call; returns the tool result as a string */
  dispatchTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Maximum turns in the agent loop (default: 20) */
  maxTurns?: number;
  /** System prompt override (default: the Claude Agent SDK's built-in prompt) */
  systemPrompt?: string;
}

export async function executeHarnessedStep(
  model: string,
  task: string,
  options: HarnessedStepOptions = {}
): Promise<string> {
  // Resolution order:
  // 1. If the model isn't Anthropic, fall through to executeApiStep (no harness).
  //    This preserves the OpenRouter fallback chain for non-Anthropic models.
  // 2. If ANTHROPIC_API_KEY (native BYOK) is present, use it directly with the
  //    Claude Agent SDK for a full tool loop.
  // 3. If only OPENROUTER_API_KEY is present, fall back to executeApiStep which
  //    routes through OpenRouter single-shot. (Claude Agent SDK does not
  //    support OpenRouter base URLs as of 2026-04.)
  // 4. Otherwise, the same hard-fail path as executeApiStep.

  const provider = detectProvider(model);
  if (provider !== 'anthropic') {
    return executeApiStep(model, task, options);
  }

  const anthropicKey = lookupKey('anthropic', options.envSecrets);
  if (!anthropicKey) {
    // Fall back to single-shot via OpenRouter (or hard-fail if no key at all)
    return executeApiStep(model, task, options);
  }

  const agentSdk = await loadClaudeAgentSdk();
  // ... actual tool-loop invocation using the Claude Agent SDK
  // ... dispatchTool wired through the SDK's MCP client hook
  // ... return final assistant message content as a string
}
```

The shape mirrors `executeApiStep` exactly: `(model, task, options) => Promise<string>`. That means the runner's wiring is a one-line change — wherever `executeApiStep` is called today for `cli: 'api'`, add a branch that calls `executeHarnessedStep` for `cli: 'harness'`.

### MCP integration via `dispatchTool`

The `dispatchTool` callback is the integration point between the harness and relay's existing MCP machinery. The runner already knows how to route tool calls through relaycast MCP for CLI-based agents (that's how `mcp__relaycast__message_post` works for `cli: 'claude'`). The harness path reuses that same plumbing: when the Claude Agent SDK emits a tool-use block, the runner's `dispatchTool` handler forwards it to the existing MCP client, gets back a result, and hands it back to the SDK.

Concretely, this means harnessed agents can:

- Post to channels, DM other agents, read inboxes (via `mcp__relaycast__*`)
- Read/write files inside the sandbox's workspace (via the Agent SDK's built-in file tools)
- Fetch HTTP (Agent SDK built-in)
- Use any other MCP server the workflow is configured to expose

No special casing. The harness is a tool-loop consumer; the runner is the tool-loop provider.

### Fallback chain for non-Anthropic models

A workflow step with `cli: 'harness'` and `model: 'gpt-4o'` today does **not** fail. It falls through to `executeApiStep`, which in turn runs the existing BYOK-then-OpenRouter-fallback logic from `api-executor.ts:130`. The user gets a one-shot response (no tool loop), but the step still completes. A warning is logged: _"Harnessed mode is Anthropic-only; falling back to single-shot for model 'gpt-4o'"_. When OpenAI's agent SDK or a cross-provider abstraction matures, the fallback can be removed without breaking any existing workflow.

---

## 4. Implementation plan

### Repos affected

| Repo                             | File                                                        | Change                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay`                          | `packages/sdk/src/workflows/api-executor.ts`                | Add `executeHarnessedStep()` + `loadClaudeAgentSdk()` helper                                                                                                                            |
| `relay`                          | `packages/sdk/src/workflows/api-executor.ts`                | Export from `packages/sdk/src/workflows/index.ts` if needed                                                                                                                             |
| `relay`                          | `packages/sdk/src/workflows/runner.ts`                      | Add `cli: 'harness'` case that calls `executeHarnessedStep` instead of `executeApiStep`. Wire `dispatchTool` to the existing MCP tool-dispatch plumbing.                                |
| `relay`                          | `packages/sdk/src/workflows/types.ts`                       | Add `'harness'` to the `AgentCli` union                                                                                                                                                 |
| `relay`                          | `packages/sdk/src/cli-registry.ts`                          | Add `harness` entry with `interactiveSupported: false` (see broker-fix spec), no binary, non-applicable args                                                                            |
| `relay`                          | `packages/sdk/src/workflows/__tests__/api-executor.test.ts` | New test: `executeHarnessedStep` throws a clear error when the peer dep is absent; falls back to `executeApiStep` for non-Anthropic models; calls the SDK for Anthropic models (mocked) |
| `relay`                          | `packages/sdk/package.json`                                 | **No change** — `@anthropic-ai/claude-agent-sdk` is already in `peerDependencies`                                                                                                       |
| `relay`                          | `package.json` (top-level)                                  | **No change** — local CLI never needs the harness                                                                                                                                       |
| `AgentWorkforce/cloud` (sibling) | `sandbox/Dockerfile`                                        | Add `@anthropic-ai/claude-agent-sdk` to the existing `npm install` line (~line 26)                                                                                                      |
| `AgentWorkforce/cloud` (sibling) | Whatever triggers sandbox image rebuild                     | Rebuild + push the base image to `ghcr.io/agentworkforce/relay-sandbox:latest`                                                                                                          |

### Ordering

1. **Relay-side PR first.** The `executeHarnessedStep` function works in isolation (the tests mock the peer dep). No sandbox changes required to land this PR. Merge to main, cut a new `@agent-relay/sdk` release.
2. **Sandbox Dockerfile PR second.** Touches only `AgentWorkforce/cloud/sandbox/Dockerfile`. One-line addition to the `npm install`. Rebuild the image. Deploy.
3. **Smoke test third.** A tiny workflow `workflows/test-harnessed-step.ts` with a single `cli: 'harness'` step that asks Claude to read a file and summarize it. Run via `agent-relay cloud run` to confirm the sandbox has the new dep and the loop works end-to-end.

Each PR is independently reviewable and independently reversible. The feature is effectively gated by whether the sandbox has the dep installed — until the sandbox PR lands, any `cli: 'harness'` step in the cloud will hit the dynamic-import error path with the helpful message. That's a safe failure mode, not a regression.

### Which workflow tool to use

For the relay-side changes, a single DAG workflow (`workflows/add-harnessed-step.ts`) following the `fix-broker-spawn-bugs.ts` pattern:

- Worktree-isolated on `feature/harnessed-step` branch
- 3 parallel fix steps (api-executor changes, runner wiring, types + cli-registry entry) using `preset: 'worker'` codex workers
- Then: typecheck gate → vitest gate → claude reviewer → final typecheck → diff display

The sandbox-side change is a one-line Dockerfile edit — not worth a workflow. Manual edit + commit + push.

---

## 5. Open questions

1. **Claude Agent SDK MCP surface.** Does the Claude Agent SDK expose a pluggable MCP client, or does it expect to manage MCP connections itself? If the latter, we may need to pre-configure the relaycast MCP server inside the sandbox before the harness spawns, rather than injecting it via `dispatchTool`. **Decision needed**: read the Agent SDK docs and confirm the integration point before implementation.

2. **Turn budget default.** Is 20 turns the right default `maxTurns`? Too low and common multi-file tasks fail; too high and a runaway loop burns tokens. Look at what Claude Code's own default is and match it.

3. **OpenAI harness story.** The debate raised this as a legitimate gap. `@openai/agents` is already a peer dep — is it a plausible second implementation slotted behind the same `executeHarnessedStep` entry point, with provider detection routing to the right harness? Or should we wait until one harness proves itself before adding a second? **Lean**: wait.

4. **Claude Agent SDK vs the Claude Code CLI running inside the sandbox.** We already have `claude` installed in the sandbox. Why not just spawn `claude -p` as a subprocess from within a cloud workflow step? Answer: that's exactly what `cli: 'claude'` already does. The harnessed path is only valuable if it's meaningfully lighter-weight (startup cost, memory footprint, no PTY overhead). **Validation needed**: measure the per-step overhead of `claude -p` vs an in-process Agent SDK call before committing to this as a real feature. If the overhead delta is small (<1 second, <50MB), this feature may not justify itself — stick with `cli: 'claude'` for cloud workflows.

5. **BYOK billing semantics.** When the user brings their own Anthropic key, the harness runs on their quota. When they don't, we fall back to `executeApiStep` which routes through OpenRouter with relay-managed billing. What's the right UX for making this transparent to the user? Do we log "harnessed mode falling back to OpenRouter single-shot because ANTHROPIC_API_KEY is not set" at INFO level? WARN? **Decision needed**: confirm with the billing/pricing path before implementation.

6. **Sandbox image size.** Adding `@anthropic-ai/claude-agent-sdk` to the sandbox Dockerfile grows the base image. Measure the delta before/after and confirm it's acceptable. The sandbox already carries the `claude` CLI, codex, the SDK, and several MCP servers, so the marginal cost is probably small, but worth confirming before pushing a new base image.

---

## 6. Rollout

1. **Phase 1 — plumbing.** Relay PR lands `executeHarnessedStep` with dynamic import. Tests prove the dynamic import fails cleanly without the peer dep, and that non-Anthropic models fall back. This PR is safe to merge — no user-visible behavior change (no one can use `cli: 'harness'` yet because the runner switch isn't wired).
2. **Phase 2 — runner wiring.** Second relay PR adds the `cli: 'harness'` case to the runner and wires `dispatchTool` to the MCP client. Also extends `AgentCli` union, updates `cli-registry.ts`. This is the PR that makes the feature callable. Still won't actually work in cloud until Phase 3.
3. **Phase 3 — sandbox dep.** Cloud repo PR adds `@anthropic-ai/claude-agent-sdk` to `sandbox/Dockerfile`. Rebuild image. Deploy.
4. **Phase 4 — smoke test.** Run `workflows/test-harnessed-step.ts` via `agent-relay cloud run`. Confirm the harness actually executes a multi-turn tool loop in the sandbox.
5. **Phase 5 — docs.** Add a section to `docs/reference-workflows.md` (and its mirror `web/content/docs/reference-workflows.mdx` per the docs-sync rule) documenting `cli: 'harness'` as an option, with the BYOK and fallback semantics spelled out.

Rollback for Phase 3: revert the Dockerfile line, rebuild, deploy. `cli: 'harness'` steps then hit the dynamic-import error with the helpful message — the feature disables itself cleanly.

---

## 7. Future work

- **OpenAI harness via `@openai/agents`.** Second implementation behind the same `executeHarnessedStep` entry point. Routes by provider detection. Only undertaken after the Anthropic path proves itself in production.
- **Gemini harness via `@google/adk`.** Same pattern, third implementation.
- **Consumer Electron app integration.** Document how a consumer app embeds `@agent-relay/sdk` + `@anthropic-ai/claude-agent-sdk` and runs harnessed workflows without the cloud sandbox. This is the actual end-user story the "harnessed direct-model" mode is built for — the cloud sandbox is just the first production runtime.
- **Streaming token output to the runner's step reporter.** The initial implementation returns a single string from `executeHarnessedStep`. A streaming variant that yields token-by-token would let the runner UI show progress during long tool-loop sessions.
- **Turn budget telemetry.** Emit the actual number of turns used per harnessed step so we can tune the default `maxTurns` based on real usage.
- **Harnessed mode in local CLI.** If there's demand, add `@anthropic-ai/claude-agent-sdk` as an optional dep to `relay/package.json` so `agent-relay run` can execute harnessed workflows locally without the cloud sandbox. Currently out of scope — the whole point of harnessed mode is to avoid the CLI binary, so running it inside the local CLI is a weird use case.

---

## 8. Related work

- **Debate transcript**: `.relay/debates/direct-model-harness/transcript.md` — the live debate that surfaced the harness trade-offs
- **Debate verdict**: `.relay/debates/direct-model-harness/verdict.md` — recommended Anthropic SDK (but conflated `@anthropic-ai/sdk` with `@anthropic-ai/claude-agent-sdk`; this spec corrects that)
- **OpenRouter + BYOK provider**: `packages/sdk/src/workflows/api-executor.ts` — the BYOK-plus-managed-fallback chain that `executeHarnessedStep` reuses for non-Anthropic models
- **Broker spawn bug fixes**: `workflows/fix-broker-spawn-bugs.ts` — unrelated to harnessed mode but shares the worktree-per-bug pattern this spec's implementation workflow will use
- **Sandbox Dockerfile**: `AgentWorkforce/cloud/sandbox/Dockerfile` — the one place the peer dep actually gets installed
- **Peer dep pattern**: `packages/sdk/package.json` — pre-existing pattern this spec follows rather than invents
