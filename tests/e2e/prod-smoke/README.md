# Production node-providers smoke

Synthetic monitoring for the node-providers model against a **deployed** engine
(`cast.agentrelay.com` by default). It self-mints a throwaway workspace, so no
credentials are configured and no real workspace is touched.

`prod-smoke.mjs` drives, in one process:

1. **create** a throwaway workspace (`POST /v1/workspaces`, no auth) — its id is
   logged immediately so a crashed run is manually recoverable.
2. **`node up`** — a Rust broker provider + a TS capability provider
   (`agent-relay.ts`, one `hello-prod` action) attach to one node, hermetically
   (ambient `RELAY_*` / `AGENT_RELAY_*` never inherited; own `HOME`, project dir,
   state dir; broker self-mints the node token from the workspace key).
3. **both providers online** — `GET /v1/nodes` shows the node `online` +
   `handlers_live`, aggregating the broker's `capacity` (`spawn:*`, `release`) and
   the TS provider's `action` (`hello-prod`) with the correct `kind`s.
4. **remote invoke** — a second, HTTP-only caller (agent token) invokes the
   node-addressed action and polls it to `completed` with a **byte-exact echo**
   round-trip.
5. **`ctx.relay.sendMessage`** — the handler posts to a channel via the node-token
   message route, attributed to a workspace agent; asserted from channel history.
6. **teardown liveness** — stopping `node up` drops the node `offline`
   (per-provider liveness).
7. **delete** the throwaway workspace.

Teardown (stop node, delete workspace) runs on success, failure, and `SIGINT` /
`SIGTERM`. All printed output is structurally redacted (the shipped
`redactSecrets`); intentionally-shown tokens are truncated to a prefix.

## Relationship to `tests/e2e/fleet`

`tests/e2e/fleet` is the **per-PR** matrix — it boots a **local** engine as a
merge gate. This smoke targets **already-deployed** infrastructure on a schedule
and is **not** a merge gate. Real broker / `node up` runtimes are sanctioned here
(a dedicated workflow), never in the unit suites (repo rule).

## Running

```bash
npm run build:core                               # relay CLI + fleet + harness-driver
cargo build --release --bin agent-relay-broker   # broker
npm run smoke:prod                               # smoke cast.agentrelay.com
```

Params (env):

| Var                     | Default                       | Meaning                                |
| ----------------------- | ----------------------------- | -------------------------------------- |
| `PROD_SMOKE_BASE_URL`   | `https://cast.agentrelay.com` | Engine to smoke                        |
| `PROD_SMOKE_TIMEOUT_MS` | `60000`                       | Wait for the node to come fully online |
| `BROKER_BINARY_PATH`    | `target/release` build        | Broker binary override                 |

Exit code is `0` on all checks passing, non-zero otherwise. The
`Prod Smoke` GitHub Actions workflow (nightly + `workflow_dispatch`) builds the
CLI + broker and runs it.
