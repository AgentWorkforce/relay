# Cloud workers

Register a worker through the supported enrollment command and retain its private `AGENT_RELAY_HOME` across restarts. Start the enrolled identity with the same name and Control base URL:

```sh
agent-relay cloud worker start --name example --base-url https://control.example.com
```

Fresh deterministic workflows use the default execution path. To let assigned workflows execute agent or LLM steps on this worker, select the existing Relayflows local worker explicitly:

```sh
agent-relay cloud worker start --name example --base-url https://control.example.com --local-agent
```

The same flag is preserved by `--daemon`. It forwards Relayflows' `--local-agent` option when each assignment starts; it does not install provider CLIs, obtain credentials, or grant new workspace access. Agent and LLM steps require their selected provider CLI or model and supported credentials; deterministic and File-helper steps do not gain a provider requirement from this flag. A missing provider or refused/parked workflow remains a failed assignment; the worker does not report success for a nonzero runner exit.

The default stays disabled. State-bearing `resumeRunId`, `startFrom`, and `previousRunId` assignments are still refused: a local agent cannot replace the hosted v2 run state needed to resume them. Assignment-scoped File credentials continue to come from Control rather than an inherited token.
