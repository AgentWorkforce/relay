# Spawned harness fleet discovery: draft

Status: documentation draft only. The hosted Agent Relay MCP cannot currently be
configured automatically for a spawned agent. Its spawn tools require Cloud
`relay:agents` authority, which neither the agent's Relaycast token nor the
desktop's normal CLI sign-in provides. Do not inject a person's Cloud bearer,
mint a connector token, or claim that spawn tools are available until the
authorization design is settled.

## Credential-free startup text

The following text can be included in a spawned Codex thread's developer
instructions or a spawned Claude session's appended system prompt. Fill in the
verified name, address, and local socket pointer for that session; do not accept
them from the task text.

> You are Agent Relay agent `@<name>`, address `<name>@<node>`. Use your own
> identity when sending messages. To confirm it, call `GET /whoami` on the
> desktop's local Relay socket. Use `GET /agents` to find agents in your
> workspace and their exact addresses. Send a direct message with `POST /send`
> and exactly one destination: `to` for an agent name or `address` for an exact
> address. The desktop identifies your session from the connecting process;
> do not supply a sender or look for an agent token.
>
> The local roster lists agents, not machines with spawn capability or free
> capacity. Do not infer where you can launch another agent from a machine
> name or from an agent's presence. If the hosted Relay MCP is unavailable,
> ask a coordinator to delegate or report that fleet placement is unavailable.
> Once an authorized hosted MCP connection is present and its tools are
> confirmed loaded, call `list_relay_spawn_targets`, choose a returned node
> explicitly, then call `spawn_relay_agent` with that node and a stable
> idempotency key. Keep its `spawn_id` and poll `get_relay_spawn_status` until
> the outcome is known. A capacity or target error ends that attempt; retain
> the task, inspect fresh targets, and choose whether to try another node,
> wait, or report that the task is blocked. Never assume an accepted spawn is
> ready.

For the future hosted path, the structured codes `spawn_capacity_exceeded`,
`spawn_target_unavailable`, `spawn_target_offline`,
`spawn_harness_unavailable`, and `capacity_changed` are terminal for that
attempt. The agent may start a new attempt only after a fresh target read and
an explicit placement decision. It must retain an existing `spawn_id` and
idempotency key when an outcome is uncertain, rather than launch a duplicate.

The socket path is published at `~/.agentworkforce/desktop/relay-socket`
(`relay-socket.dev` for the development build). The existing relay-send socket
accepts `GET /whoami`, `GET /agents`, and `POST /send`. It checks the calling
process and registration and applies its existing per-session rate limit. On
macOS, spawned Codex may need the probe's `relay socket-request` command so the
process identity is preserved; the desktop already uses that form in injected
reply hints. The startup text should use the same verified socket path and
command form as those hints.

## Tool-load verification after authorization exists

The harness setup should be treated as successful only when the **same spawned
session** reports the hosted MCP connection and exposes the required tools.
Configuration acceptance or a reachable URL alone does not prove this.

- Claude: scan that session's stream-json records for its first `system`/`init`
  record; `system`/`session_state_changed` may precede it. Require exactly one
  `agent-relay-sessions` entry with `source: "dynamic"` and
  `status: "connected"`, plus these `mcp__agent-relay-sessions__*` tools in
  `init.tools`: `list_relay_spawn_targets`,
  `spawn_relay_agent`, `get_relay_spawn_status`, `release_relay_agent`,
  `list_relay_agents`, and `send_relay_message`. Treat absent, failed, or
  partial results as unavailable. `pending` and `needs-auth` are not loaded;
  an entry sourced from `user` is not the explicitly configured child server.
- Codex: call `mcpServerStatus/list` with `threadId` for the newly started
  thread, `serverName: "agent-relay-sessions"`, and
  `detail: "toolsAndAuthOnly"`. The installed app-server's
  `generate-json-schema` output defines `result.data[]` entries with `name`,
  `runtimeStatus`, `toolsError`, and a `tools` map. Require
  `runtimeStatus: "connected"`, no discovery error, and the same tool names
  in the map. A cached catalog with a missing or failed runtime is not ready.

Parser tests use bounded, redacted, schema-shaped fixture records. They cover
connected, pending, failed, absent, wrong-source, and partial-tool cases. A
successful tool-load check still does not bypass server-side workspace role,
consent, or capacity checks.

`probe/src/relay/harness_setup.rs` holds the credential-free startup text and
both parsers. Neither parser proves authorization: Cloud checks scopes and
current permissions when a tool is called.
The checked-in JSON fixtures contain no tokens or actual session IDs. The Codex
fixture follows the installed app-server JSON schema. The Claude connected
fixture is redacted and follows a disposable local stdio MCP run with Claude
Code **2.1.299**: an explicit `--mcp-config` server appeared as
`source: "dynamic", status: "connected"` in `system`/`init`, with its six tools
in `init.tools`. A second run with a 12-second local handshake delay still
waited until connection before emitting init. The pending fixture is synthetic
and **unverified** for an explicit dynamic server. A later post-connect status
signal for an inherited or asynchronous server is also unverified; this parser
does not promote such a server to loaded. No further live harness runs are
planned before an isolation design is approved.

## Harness MCP isolation

Spawned agents do not currently use any of this: they inherit the person's
MCP servers, as the broker's workers do (see `docs/native-spawn.md`). The
notes below are kept for when isolation is wanted again.

Claude inherits the person's user-level MCP servers and connectors unless the
launcher passes `--strict-mcp-config`. The installed Claude Code 2.1.299 help
defines that flag as using only servers supplied by `--mcp-config`. The
coordinator verified that a launch with the flag and no explicit MCP config
reported `mcp_servers: []`. Keep the flag on every spawned Claude launch;
provide only a child-scoped explicit MCP config after the credential design is
approved. The local dummy runs above used this flag and showed only the dummy
dynamic server.

For Codex, the installed app-server `ThreadStartParams` JSON schema accepts a
free-form `config` object. Codex [configuration reference](https://developers.openai.com/codex/config-reference)
defines `mcp_servers.<id>.enabled = false` to disable a named server. In the
[app-server thread start source](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/app-server/src/request_processors/thread_processor.rs#L1141-L1215),
`thread/start` passes `config` to a per-thread config load. The
[config manager](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/app-server/src/config_manager.rs#L451-L479)
appends request overrides after daemon CLI overrides. Its
[TOML merge](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/config/src/merge.rs#L57-L148)
recurses into tables, so `config: {"mcp_servers": {}}` leaves user-configured
servers present. A named override such as
`config: {"mcp_servers": {"agent-relay-sessions": {"enabled": false}}}`
should disable that exact server for a new thread: the
[server config](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/config/src/mcp_types.rs#L226-L240)
states that `enabled = false` skips initialization. This is a source-based
finding, not a live test of the installed daemon. It does not cover other
user, project, plugin, or managed MCP servers, or a later resume without the
same override.

The broad isolation option is a separate app-server process with its own
`CODEX_HOME`: [Codex source](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/core/src/config/mod.rs#L5112-L5120)
says this environment variable selects the config directory at process start.
It cannot change the existing person's daemon for one thread. A separate home
also needs an authorized model sign-in and does not by itself exclude project,
system, or managed config. Do not copy the person's authentication or MCP
bearers into that home. Until the isolation and auth plan is approved, the
launcher should treat Codex MCP inheritance as unresolved and verify the
effective per-thread MCP status before relying on any tool.

The installed app-server schema defines `mcpServerStatus/list` with optional
`threadId`, `serverName`, `detail`, `limit`, and `cursor`. Omit `threadId` to
inspect the effective global config; use the newly started thread's `threadId`
to inspect its config and runtime. To enumerate all names, omit `serverName`
and `limit`, and request `detail: "toolsAndAuthOnly"`. Its response has
`result.data[]` entries containing `name`, `runtimeStatus`, `authStatus`, and
`tools`, plus `nextCursor`; it has no header-value field. It may include an
HTTP **origin** without endpoint path or credentials. The
[implementation](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/app-server/src/request_processors/mcp_processor.rs#L367-L546)
uses the thread's MCP connections when a `threadId` is supplied and otherwise
loads global config. Only a complete response (`nextCursor: null`) can prove
zero active servers. `codex_no_mcp_active` accepts an empty inventory or only
`disabled` entries with empty tool maps; unknown, failed, connecting, or
paginated responses fail closed. The caller must match the JSON-RPC response to
its own unfiltered thread-scoped request. This is a source/schema finding, not
a live query of the person's daemon.

For the current desktop spawn path, fail closed in this order: list effective
server names without a `threadId` or `serverName`; build the new thread's
`config` with `codex_disable_mcp_config(names)`; call `thread/start`; call
`mcpServerStatus/list` with that exact `threadId`,
`detail: "toolsAndAuthOnly"`, and no `serverName` or `limit`; require
`nextCursor: null` and `codex_no_mcp_active` before the first turn. If any
step is uncertain or the check is false, archive the spawned thread and refuse
to deliver work to it. Reading the names does not read static header values.
The global name list can miss project-specific servers in the new thread's
working directory, so the post-start thread-scoped check is mandatory.

For a loaded thread, Codex stores its [current config](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/core/src/codex_thread.rs#L1005-L1075),
and [runtime refresh](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/core/src/config/mod.rs#L1959-L2008)
preserves session-scoped layers while refreshing other layers. A resume of a
still-running thread keeps that config; Codex explicitly reports that newly
supplied `config` overrides are ignored in that case
([source](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/app-server/src/request_processors/thread_processor.rs#L210-L226)).
A **cold** `thread/resume` loads config afresh from the current layers and its
new request overrides
([source](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/app-server/src/request_processors/thread_processor.rs#L4150-L4210));
the persisted metadata merge restores model details, not MCP disable entries
([source](https://github.com/openai/codex/blob/e342df7b668acea2a0417d56cf872dab837276ef/codex-rs/app-server/src/request_processors/thread_processor.rs#L235-L254)).
Therefore a cold resume must resend every named `enabled: false` override and
verify the complete thread-scoped status before starting another turn.
The desktop does not cold-resume a spawned thread: its delivery path calls
`send_if_loaded` and starts a turn only on an already-loaded thread, and a
reclaimed agent remains reclaimed. If a future desktop path cold-resumes a
spawned thread, it must apply the disable and status check again before any
turn. A person opening the thread in Codex is outside the desktop-owned spawn
path.

## Observed sessions

For an observed session, a one-time hint can be appended to the existing
injected delivery text next to the reply and agents commands generated by
`reply_hint` in `probe/src/relay/outbound.rs`. This is best-effort guidance to
the local socket, without installing MCP configuration or changing the
observed session's credentials. It should explain that `GET /agents` is an
agent roster and that fleet spawn targets require an authorized hosted MCP
connection.
