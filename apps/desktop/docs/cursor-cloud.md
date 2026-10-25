# Cursor Cloud agents

Cursor Cloud is a hosted Relay provider, identified as `cursor-cloud`. It is
not the local `cursor-agent` CLI and does not use terminal wrapping, readiness
polling or prompt injection.

It does not use the Fleet API. Relay Desktop already owns the shared core
contract and roster, while Agent Relay Cloud owns the provider credential,
native Cursor calls and hosted Relay participant.

Agent Relay Cloud owns the Cursor API credential. The desktop core authenticates
only to Agent Relay Cloud and exposes typed `cursor_cloud.*` contract methods;
provider credentials never enter the app contract, diagnostic logs or an agent
sandbox. Cloud calls Cursor's public v1 API, whose durable agent and per-prompt
run model supplies the native operations Relay needs:

- list supported models, cached repositories, environments, durable agents and
  their runs;
- create an agent and its initial run;
- inject a follow-up with Cursor's `delivery: "steer"`, which steers the
  current turn or queues the next one;
- read or cancel run state, final text and pushed branches or pull requests;
- archive and unarchive an agent. Relay never maps release to Cursor's
  irreversible delete operation.

Cloud registers a launched agent in Relay with `session_kind: cursor-cloud`.
Before Cursor creates the agent, Cloud registers its hosted Relay identity and
adds a pinned `agent-relay@14.0.0` stdio MCP server to Cursor's create request.
Only that identity's scoped agent token and Relay URL enter the Cursor VM; the
Cursor API key and Relay workspace key do not. This gives the agent native
roster and peer-messaging tools. The registration's delivery adapter separately
turns a Relay direct message into a native Cursor follow-up and reports its
accepted or queued state. `client_request_id` is the Relay-side idempotency key
for create and follow-up operations because Cursor's steer response does not
include a run id.

Cloud durably polls accepted work because Cursor v1 has no webhooks. Terminal
results and pull-request links are posted back to the originating Relay message
with a stable writeback key.

RelayHistory records each run from Cursor's run event stream, which Cursor
retains for a limited window after the run ends. While that stream is
available, RelayHistory stores its assistant, status, thinking, tool-call and
result events and marks the run's coverage `retained_stream`. Once the window
has passed, only the run summary (final text, status and pushed branches or
pull requests) remains, and RelayHistory marks the run as summary-only rather
than presenting it as a complete transcript.

## Desktop surface

`cursor_cloud.*` is a contract surface for agents, the CLI and Cloud-driven
flows. Like Replicas, neither the macOS app nor the GTK app (Linux and
Windows) has a dedicated Cursor Cloud management screen. Both apps show
Cursor Cloud agents in the roster with the Cursor Cloud name and icon, and
both classify the same read-only methods as safe to repeat after a reconnect.
A management screen, if one is added, must ship on macOS and GTK together.

`client_request_id` is required on `cursor_cloud.agents.spawn` and
`cursor_cloud.runs.create`: up to 128 letters, digits, `-`, `_`, `.` or `:`.
Reuse it when you retry a call so Cloud returns the original result instead
of launching a second agent or sending the follow-up twice. Releasing an
agent is `cursor_cloud.agents.archive`, which `cursor_cloud.agents.unarchive`
reverses.

Cursor's v1 Cloud Agents API is public beta. The Cloud adapter normalizes its
camel-case provider responses into this core's snake-case contract so provider
schema changes remain at the hosted boundary. The upstream reference is
<https://cursor.com/docs/cloud-agent/api/endpoints>.
