# Doctor Orchestration Repros

These are deterministic local repros for orchestration states that previously
required comparing `status`, `who`, and messaging command output by hand.
Credential values in observed output are redacted.

## Stale or Wrong Broker Connection

Run from a temporary project with the built CLI:

```bash
CLI=/Users/khaliqgant/Projects/AgentWorkforce/relay/dist/src/cli/index.js
TMP=$(mktemp -d /tmp/relay-repro-A-C-XXXXXX)
cd "$TMP"
node "$CLI" up --no-dashboard --port 49200
cat .agent-relay/connection.json
node "$CLI" status
node "$CLI" who --json
kill -9 11078
node "$CLI" up --no-dashboard --port 49300
node -e 'const fs=require("fs"); const old=JSON.parse(process.argv[1]); const next=JSON.parse(process.argv[2]); old.pid=next.pid; fs.writeFileSync(".agent-relay/connection.json", JSON.stringify(old,null,2));' "$CONN1" "$CONN2"
cat .agent-relay/connection.json
node "$CLI" status
node "$CLI" status --wait-for=1
node "$CLI" who --json
```

Observed output:

```text
Broker started.
Broker PID: 11078
Stop with: agent-relay down

{
  "api_key": "br_<redacted>",
  "pid": 11078,
  "port": 49201,
  "url": "http://127.0.0.1:49201"
}

Status: RUNNING
Mode: broker (stdio)
PID: 11078
Project: /private/tmp/relay-repro-A-C-HuYoNc
Agents: 0
Workspace Key: rk_live_<redacted>
Observer: https://agentrelay.com/observer?key=rk_live_<redacted>

[]

Broker started.
Broker PID: 11410
Stop with: agent-relay down

{
  "api_key": "br_<redacted>",
  "pid": 11410,
  "port": 49201,
  "url": "http://127.0.0.1:49201"
}

Status: RUNNING
Mode: broker (stdio)
PID: 11410
Project: /private/tmp/relay-repro-A-C-HuYoNc

Status: STARTING
Mode: broker (stdio)
PID: 11410
Project: /private/tmp/relay-repro-A-C-HuYoNc
Broker process is running, but the API did not become ready before timeout.

[]
```

## Unresolved API Key Template

With the same temporary project, the correctly resolved broker session key
allowed an orchestrator read to reach Relaycast:

```bash
node "$CLI" replies WorkerA --json
```

Observed output:

```text
No DM conversation with WorkerA.
```

The literal unresolved template fails before a meaningful orchestrator read:

```bash
RELAY_API_KEY='${RELAY_API_KEY}' node "$CLI" replies WorkerA --json
```

Observed output:

```text
Failed to initialize relaycast client: Workspace key required (rk_live_...)
```

## Half-Started Broker With Missing Metadata

Run with Relaycast environment variables unset so messaging commands must rely
on local broker metadata:

```bash
CLI=/Users/khaliqgant/Projects/AgentWorkforce/relay/dist/src/cli/index.js
RUN=(env -u RELAY_API_KEY -u RELAY_AGENT_TOKEN -u RELAY_WORKSPACES_JSON -u RELAY_DEFAULT_WORKSPACE -u RELAY_WORKSPACE_ID -u RELAY_BASE_URL -u RELAY_BROKER_URL -u RELAY_BROKER_API_KEY -u RELAY_AGENT_NAME -u RELAY_AGENT_TYPE -u RELAY_STRICT_AGENT_NAME node "$CLI")
TMP=$(mktemp -d /tmp/relay-repro-half2-XXXXXX)
cd "$TMP"
"${RUN[@]}" up --no-dashboard --port 49600
rm .agent-relay/connection.json
ps -p 15596 -o pid=,comm=
"${RUN[@]}" status
"${RUN[@]}" history
"${RUN[@]}" replies WorkerA --json
"${RUN[@]}" up --no-dashboard --port 49700
```

Observed output:

```text
Broker started.
Broker PID: 15596
Stop with: agent-relay down

15596 /Users/khaliqgant/Projects/AgentWorkforce/relay/target/release/agent-relay-broker

Status: STOPPED

Failed to initialize relaycast client: Failed to read broker connection metadata. Start the broker with `agent-relay up` or set RELAY_API_KEY.

Failed to initialize relaycast client: Failed to read broker connection metadata. Start the broker with `agent-relay up` or set RELAY_API_KEY.

Broker background start did not become ready within 10s (pid: 16245).
Run `agent-relay status --wait-for=10` for details, or `agent-relay down --force` to clean up.
```
