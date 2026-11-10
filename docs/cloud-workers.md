# Cloud workers

Register a worker through the supported enrollment command and retain its private `AGENT_RELAY_HOME` across restarts. Start the enrolled identity with the same name and Control base URL:

```sh
agent-relay cloud worker start --name example --base-url https://control.example.com
```

Fresh deterministic workflows use the default execution path. TypeScript assignments are materialized as `.flow.ts` files so the SDK selects its authored-flow entrypoint; their directory and source body are preserved. When an isolated assignment has no Surface package, the worker links the CLI's pinned Surface into its run directory. An assignment-provided Surface stays unchanged and must pass the SDK's normal compatibility checks. To attach the supported Relayflows local agent worker to assigned workflows, select it explicitly:

```sh
agent-relay cloud worker start --name example --base-url https://control.example.com --local-agent
```

Authored TypeScript assignments require Node.js 22.12 or newer, or Bun. Standalone builds also need that Node version for their SDK child. The worker enables Node's type stripping in the assignment child's environment, including the SDK child used by standalone builds, while preserving existing Node options.

The same flag is preserved by `--daemon`. With the pinned SDK, YAML assignments attach an agent worker; authored TypeScript assignments attach agent and LLM workers. YAML `llm` steps require a separate compatible LLM worker and can still park without one. It forwards Relayflows' `--local-agent` option when each assignment starts; it does not install provider CLIs, obtain credentials, or grant new workspace access. Agent and LLM steps require their selected provider CLI or model and supported credentials; deterministic and File-helper steps do not gain a provider requirement from this flag. A missing provider or refused/parked workflow remains a failed assignment; the worker does not report success for a nonzero runner exit.

The default stays disabled. State-bearing `resumeRunId`, `startFrom`, and `previousRunId` assignments are still refused: a local agent cannot replace the hosted v2 run state needed to resume them. Assignment-scoped File credentials continue to come from Control rather than an inherited token.
