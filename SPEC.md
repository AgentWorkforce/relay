# Multi-Workspace Support Spec

## Repo scope
This repo is the **primary runtime implementation** for the multi-workspace MVP. It owns the session/auth/cache model, runtime event routing, local send APIs, and the PTY injection path that currently all assume one implicit workspace.

## Relevant plan slice
- Replace singular auth/cache/session assumptions with a collection-aware workspace membership model.
- Introduce `MultiWorkspaceSession` so one runtime process can connect to many Relaycast workspaces concurrently.
- Make every inbound event workspace-scoped before routing, replay, PTY injection, or local API handling.
- Make outbound send APIs workspace-aware with explicit resolution rules.
- Preserve legacy single-workspace env vars, cache files, and `/api/send` behavior whenever the default workspace is unambiguous.
- Render workspace context in injected output whenever multi-workspace mode makes target names ambiguous.

## Current single-workspace flow
```text
Startup / auth
--------------
env vars + cached credentials
  -> auth.rs builds one AuthSession / CredentialCache entry
  -> main.rs starts one RelaySession

Inbound
-------
1 Relaycast WebSocket
  -> relaycast_ws.rs
  -> message_bridge.rs maps raw event
  -> types.rs carries one implicit workspace
  -> routing.rs resolves by target only
  -> main.rs / wrap.rs inject into PTY and replay state

Outbound
--------
/api/send or local runtime command
  -> listen_api.rs / main.rs
  -> relaycast_ws.rs HTTP sender
  -> 1 Relaycast workspace
```

## Proposed multi-workspace flow
```text
Startup / auth
--------------
legacy env/cache OR RELAY_WORKSPACES_JSON
  -> auth.rs loads CredentialSet { memberships[], default_workspace_id }
  -> multi_workspace.rs builds MultiWorkspaceSession
  -> one websocket + HTTP client per membership

Inbound
-------
WebSocket A ----\
WebSocket B -----+--> MultiWorkspaceSession fan-in
WebSocket N ----/       -> message_bridge.rs tags/map events with workspace_id / alias
                        -> types.rs carries WorkspaceScoped inbound events
                        -> routing.rs resolves by (workspace_id, target)
                        -> main.rs / wrap.rs render workspace-qualified PTY injection
                        -> replay/history remain workspace-aware

Outbound
--------
/api/send or runtime send request
  -> listen_api.rs accepts workspaceId / workspaceAlias
  -> main.rs resolves membership via:
       1) workspaceId
       2) workspaceAlias
       3) exactly one attached workspace
       4) configured default workspace
       5) else 400 ambiguous_workspace
  -> selected workspace HTTP/WebSocket sender
```

## Exact files to modify
- `relay/src/auth.rs`
  - Replace singular cache/session types with collection-aware `WorkspaceCredential`, `CredentialSet`, and default-workspace support; auto-upgrade legacy cache in memory.
- `relay/src/multi_workspace.rs`
  - New `MultiWorkspaceSession` and `WorkspaceMembership` orchestration for many websocket memberships and merged event fan-in.
- `relay/src/lib.rs`
  - Export the new shared abstractions for reuse in wrappers/tests.
- `relay/src/relaycast_ws.rs`
  - Manage per-membership websocket and HTTP clients; add workspace-aware `send(...)` behavior.
- `relay/src/message_bridge.rs`
  - Accept workspace context and emit workspace-scoped broker events.
- `relay/src/types.rs`
  - Add `workspace_id` / `workspace_alias` to `InboundRelayEvent`, `BrokerCommandEvent`, and `InjectRequest`.
- `relay/src/main.rs`
  - Replace singular `RelaySession`, update merged receive loop, self-echo filtering, outbound send resolution, history/replay handling, and injection formatting.
- `relay/src/routing.rs`
  - Route by `(workspace_id, target)` instead of `target` alone.
- `relay/src/wrap.rs`
  - Bootstrap multi-workspace runtime paths and render workspace-qualified inbound injections.
- `relay/src/spawner.rs`
  - Inject `RELAY_WORKSPACES_JSON` and `RELAY_DEFAULT_WORKSPACE` while preserving legacy single-workspace env vars.
- `relay/src/snippets.rs`
  - Update generated CLI/MCP snippets for multi-workspace startup while keeping default-workspace compatibility.
- `relay/src/listen_api.rs`
  - Extend `/api/config`, `/health`, and `/api/send` to report memberships and accept explicit workspace routing.

## Acceptance criteria
- Runtime can load either legacy single-workspace configuration or a multi-membership `CredentialSet`.
- One runtime process can connect to multiple workspaces simultaneously and merge inbound events into one workspace-scoped stream.
- `InboundRelayEvent`, `BrokerCommandEvent`, and `InjectRequest` carry `workspace_id` and optional alias end-to-end.
- Routing resolves destinations by `(workspace_id, target)` instead of target name alone.
- `/api/send` accepts `workspaceId` and `workspaceAlias`, and returns `400 ambiguous_workspace` when workspace selection is required but absent.
- `/api/config` and `/health` report membership lists and default workspace state while keeping legacy single-workspace fields for compatibility.
- PTY injection and replay output visibly include workspace context whenever multiple attached workspaces make collisions possible.

## Backwards compatibility notes
- Legacy env vars (`RELAY_API_KEY`, `RELAY_BASE_URL`, `RELAY_CHANNELS`, `RELAY_AGENT_NAME`) continue to build a one-membership runtime.
- New env vars are additive: `RELAY_WORKSPACES_JSON`, `RELAY_DEFAULT_WORKSPACE`, and optional workspace aliases.
- Old cache files are promoted in memory to a v2 `CredentialSet` with `memberships: [old_entry]` and `default_workspace_id = old_entry.workspace_id`.
- `/api/send` without workspace remains valid only when there is exactly one membership or a configured default workspace.
- `/api/config.workspaceKey` remains available for older dashboards/clients and represents the default workspace only.
- Child processes still receive legacy env vars for the default workspace, plus the new multi-workspace env vars for upgraded consumers.
