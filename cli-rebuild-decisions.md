# CLI — Canonical End Shape

**Goal:** A thin operator console for a local agent workforce. Every command is a shallow
wrapper over a package method — never raw protocol / WebSocket / `child_process`.

**North star:** stand up the broker, staff it with off-the-shelf agent CLIs, watch/steer
from the terminal. Serves the cold-start moment. Building behavior is the packages' job.

## Architecture: namespace → package

| CLI surface | Backing package |
|---|---|
| `workspace`, `agent`, `channel`, `message`, `integration`, `capabilities` | `@agent-relay/sdk` (messaging) |
| `local` | `@agent-relay/runtime` (`RuntimeClient`, `BrokerDriver`, `PtyInputStream`) |
| `cloud` | `@agent-relay/cloud` |
| `status`, `version`, `update`, `telemetry`, `uninstall`, `help`, `mcp` | local / composite |

The CLI's primary axis is **`local` vs `cloud`** — run agents on my machine vs hosted.
(The `local` namespace consumes `@agent-relay/runtime`; namespace name ≠ package name on
purpose — operator term vs implementation term.)

Locked principles: thin convenience · no dashboard (terminal is the only window) ·
`@agent-relay/sdk` stays messaging-only · **no `init`/`setup`/`doctor`** (onboarding is just
`relay local up`).

---

## Command tree

### Top-level
```
relay status            # workspace/key + cloud login + local broker status (if running)
relay version
relay update
relay telemetry
relay uninstall         # removes .agentworkforce/relay files
relay help
relay mcp               # MCP stdio server
```
`relay status` is the one composite read: current workspace/key (sdk/config) + cloud
`whoami` (cloud) + is-the-daemon-running (local). Distinct from `relay local status`.

### Messaging → `@agent-relay/sdk`  *(require agent token)*
```
relay workspace      create | list | set_key | join | switch
relay agent          register | list | add | remove          # Relaycast directory
relay channel        create | list | join | leave | invite | set_topic | archive
relay message        post | list | reply | get_thread | search
relay message dm     send | list | send_group
relay message reaction   add | remove
relay message inbox      check | mark_read | get_readers
relay message file       upload
relay integration webhook        create | list | delete | trigger
relay integration subscription   create | list | get | delete
relay capabilities   register | list | delete
```
*Note: two `agent` words coexist by design — `relay agent` (directory) vs
`relay local agent` (local worker processes). Left as-is.*

### Cloud → `@agent-relay/cloud`
```
relay cloud   login | logout | whoami
relay cloud   auth <provider>      # provider CLI auth over SSH (moved from top-level `auth`)
relay cloud   connect
relay cloud   run | schedule | schedules | status | logs | sync | cancel
relay cloud   help
```

### Local → `@agent-relay/runtime`  *(local broker; commands no-op/exit if not running)*
```
relay local up
relay local down
relay local status                       # is the daemon running        BrokerDriver.status
relay local metrics [--agent <name>]     # resource usage               RuntimeClient.getMetrics
relay local tail [--agent <name>]        # all broker events (filterable) onEvent / subscribeWorkerStream
relay local help

relay local agent list                                   # RuntimeClient.listAgents
relay local agent spawn <provider> [--name]              # headless        spawnCli
relay local agent new <provider> [--name]                # spawn + attach  spawnCli + PtyInputStream
relay local agent attach <name> --mode drive|view|passthrough   # PtyInputStream + subscribeWorkerStream + set/getInboundDeliveryMode
relay local agent release <name> [--kill]                # graceful, or hard kill   RuntimeClient.release
relay local agent set-model <name> <model>               # injects `/model X` keystroke   RuntimeClient.setModel
```
`spawn`/`new` take a `<provider>` (claude/codex/…); name is auto-generated unless `--name`.
`attach` default mode = `view`. `release --kill` does a hard process kill (no standalone `kill`).
`set-model` injects `/model <model>` into the agent's TUI — best-effort; report "sent" not
"changed" (broker can't confirm the switch).

---

## Deltas to execute (current branch → this shape)

1. **Rename** `driver` namespace → `local`; drop `registerCoreTopLevelAliases` (no top-level
   `up/down/status` — only `local …`).
2. **Add composite `relay status`** (workspace/key + cloud whoami + local broker running).
3. **Restructure** agent ops under `local agent`: `list`, `spawn <provider> [--name]`,
   `new <provider> [--name]`, `attach <name> --mode`, `release <name> [--kill]`, `set-model`.
4. **Consolidate attach:** delete `view.ts` / `drive.ts` / `passthrough.ts`; `local agent
   attach --mode drive|view|passthrough` (default view).
5. **`release --kill`** for hard kill; remove standalone `kill`.
6. **Promote `tail` to `local tail [--agent]`** (broker-wide via `onEvent`, per-agent filter);
   remove standalone `activity`.
7. **`local metrics`** kept; **`local status`** = daemon up/down (health folded in);
   delete the `monitoring` group (incl. `profile`).
8. **Move `auth`** → `cloud auth <provider>`.
9. **Remove** `core start` (dashboard), `init`, `setup`, `doctor`, legacy `messaging` group.
10. **Migrate `on`/`off` mount** → `../relayfile` (already absent from this CLI).
</content>
