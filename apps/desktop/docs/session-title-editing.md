# Native session titles

The shared core exposes `sessions.title.capability` with `{source, session_id}`
and `sessions.title.set` with `{source, session_id, title}`. Identity comes from
provider discovery/configuration; callers cannot supply a file path, endpoint,
credential, or process. Titles are trimmed and limited to 200 Unicode characters
without control or directional/invisible formatting characters. Hermes imposes
its native 100-character limit. A successful write returns the native title.
Writes for one source/session are serialized, including after client disconnect.

No rename starts a model turn, resumes a conversation, archives a session, or
changes the agent’s Relay name/address. There is no persistent Relay-only title.

| Harness | Native route and availability |
| --- | --- |
| Codex | `thread/name/set` on the shared app-server proxy, using the configured Codex home/SQLite home; requires an existing unarchived thread and a reachable app-server. |
| Claude Code (local) | Append the native `custom-title` metadata record used by Anthropic’s `rename_session` SDK. Exact UUID in one configured shared Claude folder; symlinks, duplicate files, empty/partial transcripts are refused. A running Claude UI may show the new name when it next reloads its session metadata. |
| OpenCode | Native session update through the authenticated managed server or live Relay plugin. Existing plugin processes must reload the updated plugin to advertise title editing. |
| Grok | `x.ai/session/rename` through a kernel-verified existing/spawned leader binding. The session must already be connected; rename does not load or prompt it. Older Grok versions may refuse this metadata RPC. |
| Devin CLI (local) | Exact-ID transaction on the existing native `sessions.db` title column; no database creation, transcript rewrite, or activity-timestamp change. The Devin UI reads it when its session list refreshes. |
| Pi | The bundled extension invokes `setSessionName` and confirms through `getSessionName`. Run `/reload` in an existing session after the extension updates. Expiring metadata requests use a separate channel from message delivery. |
| OpenClaw | The root/agent-scoped history identity resolves to one Gateway conversation, verified against its local SQLite window or legacy session index. `sessions.patch` sets its label with `expectedSessionId`; older Gateways that reject this precondition are not retried without it. Custom config files and `OPENCLAW_HOME`/`OPENCLAW_PROFILE` overrides are currently unavailable, as are isolated cron run keys. A Relay agent ID is not a conversation ID. |
| Hermes | Resolve the history provider’s default/profile/custom-root identity to an exact native session in a configured local Hermes root, then call `hermes sessions rename` with that home and require matching database readback. Requires the Hermes CLI. |
| Muse | Unavailable: Relay-owned Muse spawns do not expose a verified native title-mutation route. |
| Cursor | Unavailable: there is no verified native title-mutation route in this integration. |
| Oh My Pi (`omp`) | Unavailable: history import supports Oh My Pi, but its native session manager has no Relay control binding. The Pi extension route does not apply to Oh My Pi. Rename it in Oh My Pi. |
| Antigravity (`antigravity`) | Unavailable: history import has no verified native title-mutation route in this integration. Rename it in Antigravity. |
| Claude Cloud, Devin Cloud, Cursor Cloud, Capy, Replicas | Unavailable: the current cloud integrations do not expose a verified native title-mutation route. Local metadata must not masquerade as a cloud title update. |

Availability checks cover every displayed source, with a reason when editing is
unavailable. An unsupported or older provider returns an error, never a false
success or a prompt asking the model to rename itself.

## Desktop interaction

The title editor appears only in the open session's header. **Rename** makes the
title editable without an input box. Enter, **Done**, or moving focus outside the
editor commits; Escape cancels. Focus changes are briefly debounced so suggestion
and cancel controls remain usable. Typing and unchanged titles do not trigger
native writes. Session navigation cancels pending delayed submissions.

Opening the session preloads its saved pipeline title. The sparkle applies that
suggestion to the draft without a new generation or immediate save. Failed saves
roll back the displayed title and retain the rejected draft. The table remains a
navigation surface, without rename controls or title-preload requests.

## Verification

Backend tests use temporary native metadata, fake provider transports and fake
core plugins. Pi extension tests verify metadata-only renaming, expiration,
wrong-session rejection and continued message delivery around malformed requests.
Tests do not rename real sessions.
