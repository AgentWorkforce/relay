# Agent-driven setup

Agent Relay exposes setup through the same private per-user Unix socket that
registered sessions use for replies. A running Codex, Claude or Devin session may use
these routes before it has a Relaycast identity. The app authenticates the
caller from kernel peer credentials and process ancestry; it never trusts a
session id supplied in a request.

## Headless Ubuntu installation

The supported server path is a current Ubuntu LTS `.deb`, a systemd user
service, and lingering so delivery survives the SSH login that installed it.
Replace `x64` with `arm64` when appropriate:

This path requires passwordless sudo or one human-approved sudo prompt for the
package install and `loginctl enable-linger`. Never capture or relay a sudo
password.

```sh
release=https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download
curl -fLO "$release/AgentRelay-Linux-x64.deb"
curl -fLO "$release/AgentRelay-Linux-x64.deb.sha256"
sha256sum --check AgentRelay-Linux-x64.deb.sha256
sudo apt install ./AgentRelay-Linux-x64.deb
systemctl --user daemon-reload
systemctl --user enable agent-relay.service
systemctl --user restart agent-relay.service
sudo loginctl enable-linger "$USER"
systemctl --user is-active agent-relay.service
```

The service runs `/usr/lib/agent-relay/agent-relay-probe relay serve --headless`.
It imports no GTK module,
serves the session socket, supervises uploads, discovers Codex and Claude
processes inside tmux/SSH process trees, and delivers messages without a
display. Headless startup also removes the app-owned
`~/.config/autostart/agent-relay.desktop` entry left by an older GUI setup;
the systemd user unit is the sole startup owner and does not use the GUI-only
`--background` flag. Unrelated autostart entries are preserved. The tarball contains the same unit at
`usr/lib/systemd/user/agent-relay.service` for administrators who install a
relocatable tree themselves.

Headless startup applies the agent-led defaults: Claude Code direct delivery,
automatic activation of every eligible interactive session, and upload mode
`selected`: nothing uploads until a session is chosen, as in the apps. A sign-in
through `/setup/sign-in` installs the uploader in that mode. The bootstrap never
changes an install's sharing mode, so it never widens what an install shares and
never narrows a mode its owner chose (`new` or `all` from Settings). A durable
one-time bootstrap also runs before the first `/setup/*` request on Linux and
macOS. Explicit changes made through those routes afterward, `POST
/setup/sharing` with `new` or `all` included, survive status reads and app
restarts.

Provider subscriptions from a registered local session use the private socket
described below. They do not expose or require a workspace key. The separate
npm `agent-relay` CLI remains available to workspace operators and fleet agents
that already have a workspace key.

The `.sha256` file is part of every release. Do not install an artifact whose
checksum fails. Alpine, RHEL, and old-glibc hosts are not the default package
path.

## Scriptable macOS installation

Download the release DMG and its `.sha256`, verify it, mount it, and copy the
signed app. Starting the app once creates the private socket; the setup API
does not require its window.
Copy the app before opening it. Registering the helper from a mounted DMG
records that volume as its parent; after ejection, launchd cannot start it.
The app refuses background registration outside `/Applications` or
`~/Applications` so this install order is enforced.

```sh
case "$(uname -m)" in
  arm64) relay_arch=arm64 ;;
  x86_64) relay_arch=x64 ;;
  *) printf 'Unsupported Mac architecture: %s\n' "$(uname -m)" >&2; exit 2 ;;
esac
release=https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download
curl -fL "$release/AgentRelay-macOS-$relay_arch.dmg" -o AgentRelay.dmg
curl -fL "$release/AgentRelay-macOS-$relay_arch.dmg.sha256" -o AgentRelay.dmg.sha256
sed "s#AgentRelay-macOS-$relay_arch.dmg#AgentRelay.dmg#" AgentRelay.dmg.sha256 | shasum -a 256 --check -
volume=$(hdiutil attach -nobrowse -readonly AgentRelay.dmg | awk '/\/Volumes\// {sub(/^.*\/Volumes\//,"/Volumes/"); print; exit}')
ditto "$volume/Agent Relay.app" "/Applications/Agent Relay.app"
hdiutil detach "$volume"
open -a "Agent Relay"
```

Release asset names may include a version; use the names and checksums listed
on the release when the stable aliases are unavailable.

If the socket is still absent after 30 seconds, inspect the core job with
`launchctl print "gui/$(id -u)/com.agentrelay.desktop.core"`. A job showing
`job state = spawn failed`, `last exit code = 78: EX_CONFIG`, and
`program identifier = Contents/Helpers/Agent Relay Helper` has lost its app
bundle path in macOS Background Task Management. Repeated SMAppService
registration and toggling Login Items did not repair the affected record. Builds with
the fallback repair register a user LaunchAgent with an absolute path to the
bundled helper. Check `launchctl print "gui/$(id -u)/com.agentrelay.desktop.core.local"`
and wait for the socket again. Do not use `sfltool resetbtm`: it resets other
apps' background items too.

## Finding the socket

The app writes the absolute socket path, followed by a newline, to:

```sh
socket=$(cat "$HOME/.agentworkforce/desktop/relay-socket")
```

The pointer and socket are mode `0600`; their parent directories are mode
`0700`. On Linux the normal socket is
`$XDG_RUNTIME_DIR/agent-relay/relay.sock`. Setup requests must run from inside
the Codex, Claude or Devin process tree they are configuring. A same-user process can
already read the app's private credential store, so pre-registration setup
does not widen the existing same-user trust boundary. Other users and an
unrelated same-user process are rejected.

Claude Code records each running session in
`~/.claude/sessions/<pid>.json` (under `CLAUDE_CONFIG_DIR` when set), and the
Desktop identifies a Claude caller from that file. The file is read up to the
end of its first JSON value, so a complete record followed by stray bytes still
names its session. When the caller's nearest session is a running Claude Code
process whose file does not parse at all, every route answers HTTP 409
`session_file_unreadable` with the file's path and the parse error. A file
counts as the running session's when one of its `<pid>.<hash>.key` files
records that process's start time. Claude Code writes the file when a session
starts, so exiting the session and resuming it with `claude --resume` makes it
readable again; the Desktop never writes Claude Code's files.

## Setup contract

All responses use `{"ok":true,"data":…}` or
`{"ok":false,"error":{"code":…,"message":…}}`.

| Request | Purpose |
| --- | --- |
| `GET /setup/status` | Sign-in, uploader, defaults, registration, webhook and integration state |
| `POST /setup/sign-in` | Reuse an eligible login or start device approval; optional `{"workspace":"UUID","acknowledge_uninspected_schedules":false}`. Browser-capable local clients can opt in with `flow:"browser"`. |
| `POST /setup/sharing` | `{"mode":"selected"}`, `new`, or `all` |
| `POST /setup/auto-activate` | `{"enabled":true}`; eligible interactive sessions are activated automatically, subject to the safety limits below |
| `POST /setup/direct-delivery` | `{"enabled":true}` sets Claude Code `crossSessionInbound` to `accept` (`false` removes it); `{"default":true}` applies the first-run default, which keeps a value the user already set and answers `{"direct_delivery","user_choice"}` |
| `POST /register` | Register only the calling session; optional name, description and `mcp` (`"agent-relay-sessions"` if the session has those tools, `"none"` if not) |
| `DELETE /register` | Remove only the calling session |
| `POST /webhooks` | Create the calling session's webhook |
| `DELETE /webhooks` | Revoke the calling session's webhook and private channel |
| `POST /integrations/subscribe` | Subscribe with provider and resource; a subscription the caller already holds answers `already_subscribed:true` |
| `DELETE /integrations/subscribe` | Remove that provider/resource subscription |

## Subscribe this agent to one GitHub pull request

Run this single command inside the registered Codex, Claude or Devin session that
should receive the events, giving it the address `gh pr create` printed or the
`owner/repo#number` shorthand:

```sh
~/.local/bin/agent-relay-probe relay subscribe https://github.com/AgentWorkforce/skills/pull/120
```

The command finds the socket through the pointer file, sends one request, and
prints the JSON answer; it exits non-zero when the Desktop refuses. It takes no
agent name: the Desktop identifies the calling session from the process, as it
does for `/register`. It uses the signed-in account and the calling session's
saved relay identity; no workspace key or provider token is put in the agent's
environment, argv, or request. If GitHub is not connected, finish the one-time
connection page the Desktop opens; the command waits up to seven minutes for
that, longer than the five the Desktop allows. A production Desktop creates
`~/.local/bin/agent-relay-probe` when it starts and keeps it at its own version
on Linux and macOS; a development build leaves that copy alone, so run its own
bundled probe with `--dev`, which reads Agent Relay Dev's pointer
(`relay-socket.dev`). The command never falls back from one build's pointer to
the other's.

`agent-relay-probe relay` commands wait up to 60 seconds for the Desktop to
answer. When it does not answer in time the command fails with "Agent Relay
did not answer METHOD ROUTE within 60 seconds. This is not a setup problem;
the core is still running. Try again shortly." The route is named without its
query. Retry the same command; do not re-run setup.

Repeating the command is safe. When the session already holds that
subscription the answer is a success carrying `"already_subscribed":true`, and
no cloud request is made, so an agent can run it after every pull request it
opens without first checking state. A subscription still being made or cleaned
up is not reported as held; the request goes through and can return `refused`
or `busy` until it settles.

`agent-relay-probe relay subscribe --remove <pull request>` ends it. Either
spelling of the pull request ends a subscription made with the other.

Only a registered session can subscribe; an unregistered one receives
`not_a_relay_session` with "Register this session before subscribing it", and
`POST /register` first fixes that. The command accepts exactly one numbered
pull request: a whole repository, a raw path glob, another provider, or an
address that is not `https://github.com/<owner>/<repo>/pull/<number>` is
rejected before the socket is opened.

The equivalent raw request, for clients that cannot run the probe, is one
`POST` with the same resource. On macOS, a Codex session under the shared app
server must use the probe command: the system `curl` hides the session's
identity and is answered `not_a_relay_session`.

```sh
curl -fsS --unix-socket "$(cat "$HOME/.agentworkforce/desktop/relay-socket")" \
  -H 'Content-Type: application/json' \
  --data '{"provider":"github","resource":"AgentWorkforce/skills#120"}' \
  http://relay/integrations/subscribe
```

A session started by the Agent Relay fleet broker already answers to its fleet
name and cannot register here: `/register` answers `not_a_relay_session` with
"This session is already managed by this computer's relay", and the subscribe
command asks it to register. It subscribes with the workspace CLI instead, which needs
`agent-relay` 13.0.0 or newer: `agent-relay integration subscribe github
--resource '/github/repos/<owner>/<repo>/pulls/<number>/**' --to @<its name>
--no-input`. Older CLIs let the worker's `RELAY_AGENT_TOKEN` displace the
workspace key and fail with `Workspace key required (rk_live_...)`; prefix the
command with `env -u RELAY_AGENT_TOKEN` there.

One numeric PR subscription receives new review comments, submitted reviews,
issue comments on the PR, and check-run events. Relayfile correlates those
events by the PR's stable resource reference even though their stored paths can
be under `reviews/`, `issues/`, `comments/`, or `checks/` rather than the pull
directory. The injected session text has this shape:

```text
[via Agent Relay — from @__relay_webhook__ to @connect-skill · message m_… · ref …]

Github pull_request_review_comment.created
<event summary and record>
Relayfile path: /github/repos/AgentWorkforce/skills/comments/…
```

`pull_request.closed` is injected before the binding is removed automatically;
GitHub uses that action for both closed and merged pull requests. Failed or
interrupted cleanup is retried by the Desktop, and an unfinished binding for a
different resource does not block this request.

`GET /setup/status` answers at once from the last known state; it never
waits on Relaycast, Cloud, or the uploader, and it never runs session
discovery: whether interactive sessions still await activation is checked in
the background and the last answer is reported. Work still in progress reads
as pending:

| Field | Values |
| --- | --- |
| `relaycast` | Relaycast's verification of the workspace key: `pending` while it is being asked, then `verified`, `rejected`, or `unreachable` (asked again on the next refresh); `null` while no workspace key is found |
| `defaults` | `applied` once the agent-led defaults hold with a workspace signed in or an explicit setup choice was made, else `pending` |
| `uploader` | The last uploader check (below); `{"running":false,"healthy":false,"pending":true}` before the first check answers |
| `unreadable_session_files` | Running Claude Code sessions whose `<pid>.json` does not parse, each `{"path","pid","error"}`; such a session is invisible to discovery and its commands receive `session_file_unreadable`. Empty when every file reads |

`uploader` holds:

| Field | Values |
| --- | --- |
| `running`, `paused` | Whether the collector runs, and whether the person paused uploads |
| `stage` | `not_running`, `paused`, `needs_attention`, `conflict`, `offline`, `preparing`, `uploading`, or `up_to_date` |
| `healthy` | `running`, no delivery failure, and a stage other than `needs_attention`, `conflict`, `offline`, or `not_running` |
| `stalled` | Queued records have had no acknowledgement for five minutes, whatever the failure, while the collector runs unpaused and is not being replaced or upgrading; the stage is then `needs_attention`, except that a receiver conflict keeps `conflict` and a failed cycle with no delivery failure keeps `offline` |
| `failure_code` | Why delivery fails: `transient`, `rate_limited`, `authentication_required`, `permission_denied`, `invalid_payload`, `receiver_rejected`, `unsupported_evidence`, `mapping_version_mismatch`, or `delivery_conflict`; `null` when it does not |
| `renewal_failure` | With `authentication_required`, why the upload sign-in could not be renewed from Agent Relay's own: `no_cloud_session`, `cloud_refused`, `cloud_unreachable`, or `wrong_destination`; else `null` |
| `pending_records` | Records queued and not yet acknowledged |
| `last_acknowledged_ms` | When an upload was last acknowledged (Unix ms); `null` before the first |

An upload blocked on `authentication_required` renews by itself: the core
refreshes the app's Cloud sign-in while the block lasts (backing off from one
supervision period to 32 while refresh fails), and the collector renews the
upload sign-in from it on its next pass.

Each status read starts a fresh uploader check in the background, so polling
status keeps `uploader` current. `POST /setup/auto-activate` with
`enabled:true` reports the activation it starts, so it waits on Relaycast
registration; status and the other setup routes do not wait behind it.
If the request times out, `auto_activate:true` in status confirms only that
the preference was saved. Check the session's `registered` state and
`defaults_error` before treating activation as complete.

After the first agent-led setup request, `/setup/status` reports
`sharing_mode:"selected"` (or the mode the install already had),
`auto_activate:true`, and `direct_delivery:true`.
The direct-delivery default, like the apps' first-run setup, sets `accept`
only when the user's own `~/.claude/settings.json` does not name
`crossSessionInbound`. A key that is present, with any value (`hold`,
`refuse`), is the user's explicit choice and is kept: status then reports
`direct_delivery:false` with `direct_delivery_user_choice:"hold"` and no
`defaults_error`. An absent key reads as unset. **Ask again** and
`{"enabled":false}` write `"hold"`, so they are kept as choices. Only an explicit
`{"enabled":true}` overrides a kept choice; ask the human first.
The calling session's effective delivery state remains available at
`session.direct_delivery`. If organization-managed Claude settings forbid
`crossSessionInbound:"accept"`, status reports `direct_delivery:false` and a
`defaults_error` with code `managed_policy`; an explicit direct-delivery call
returns HTTP 409 with the same code. The app never edits the managed file.

Auto-activation is deliberately narrower than session discovery. It admits
interactive Codex/Claude sessions, live Devin CLI sessions, and open Grok sessions
whose leader is reachable, excluding Agent SDK, `claude -p`, structured
pipe-driven Claude runs, `codex exec`, and sessions owned by the fleet broker.
Muse sessions are added only when Agent Relay starts and owns them. Sessions
beneath the system temporary roots are excluded by default. Set the colon-separated
`AGENT_RELAY_AUTO_ACTIVATE_EXCLUDED_DIRS` environment variable on the app or
service to replace those roots; an empty value disables only the directory
filter. At most five sessions are registered per minute and twenty
auto-activated identities may be active. An auto-activated identity whose
eligible process ends is removed after a five-minute grace period. A manually
enabled or self-registered identity whose session ends keeps its name and its
queued messages, but is neither listed nor heartbeated as present until the
session runs again.

`POST /setup/sign-in` returns `pending_approval` plus
`verification_url`, `verification_url_complete`, `user_code`, `expires_at`,
and `interval`. Existing callers retain device approval, which works from
another computer or phone. The secret device code stays in the app.

Local setup clients can pass `{"flow":"browser"}` to use the desktop's normal
sign-in: reuse an eligible saved session, otherwise open
`verification_url_complete` on the same computer. Cloud reuses the browser's
signed-in session or opens Google when needed, then returns to the app through
its PKCE loopback handoff. Open this URL even when `user_code` is null;
`interval` is also null in the browser flow. There is no code confirmation or
separate device approval screen. Remote/headless clients should omit `flow`
or explicitly pass `{"flow":"device"}`. Poll `GET /setup/status` until it
reports `signed_in`, `expired`, `denied`, or `error`.
Browser setup starts with `preparing` while it checks and refreshes existing
logins in the background. If browser sign-in is needed, it moves to
`pending_approval` during polling. Status then includes the same public
approval fields and `sign_in_phase`; open `verification_url_complete` to continue.

When an eligible same-origin CLI or saved app login is found, status reports
`reused_login:true`; no device code is issued. Workspace connection and the
required new-session baseline continue in the background. Cancellation remains
available while Cloud refreshes an existing login.
A refresh already submitted to Cloud finishes saving its rotated credentials
after cancellation; the cancelled setup does not continue connecting.

While sign-in is `preparing`, the sign-in response includes `phase`, `message`,
`poll_after_seconds`, and, once the local scan starts, `progress`. Status exposes
the same information as `sign_in_phase`, `sign_in_message`,
`poll_after_seconds`, and `sign_in_progress`. `checking_existing_login` means
the app is looking for a reusable same-origin CLI or saved app login without
yet claiming that one exists; `reusing_existing_login` means that login is
being reused; `waiting_for_browser` means Google sign-in is open;
`waiting_for_device_approval` means the explicit device fallback is waiting
for approval; `connecting_workspace` means sign-in succeeded; and
`preparing_local_sessions` means the probe is
scanning existing Codex and Claude history to establish the automatic-new-upload
baseline. Progress includes the source, processed and total file counts when
known, and locally captured session count. This scan can take about a minute on
a large history and cannot be skipped without risking uploads of pre-existing
sessions. Poll at `poll_after_seconds` until `signed_in`.

Before sign-in, the shared probe also inspects older managed upload schedules.
An active managed schedule blocks setup. A missing optional `crontab` program
or missing cron spool counts as no legacy schedule; command execution,
permission, and read failures remain an unknown inspection and require the
documented explicit acknowledgement after a manual check.

Completed status and the completed sign-in response include the signed-in
workspace id and name. Status also names the signed-in person as
`account: {"name", "email"}`, taken from `account.status`; it is `null` while
no one is known on this computer. Multi-server rollouts should always pass
their existing workspace UUID explicitly so every server joins the same
workspace.

Default registration names include a 128-bit session-derived suffix. Thus
Codex and Claude sessions sharing one host and checkout still receive unique,
unambiguous `name@direct` addresses. A successful `POST /register` returns the
registered `name` and `address`, the caller-derived `session_id`, the effective
`direct_delivery` state, and whether the registration already existed. These
session fields match the values under `session` in `/setup/status`.

No Cloud bearer, workspace key, or agent token is returned by any route or put
in a session. A newly created webhook is the single exception: its secret is
returned once, in the response to the identified calling session. Later calls
return the webhook id and URL with a null secret.

Integration setup uses the signed-in session to mint a short-lived,
workspace-bound Relayfile credential and subscribes through relayfile-cloud
directly. The relay core does this on both platforms; the session socket's
`/integrations/subscribe` is the core's route on macOS and Linux alike. An
operator's own Relayfile daemon, active workspace, and polling consumers are
never touched. No Relaycast, agent, or Relayfile credential appears in argv,
route output, or logs. The requested provider must already be connected in
the selected workspace.

### Resources for other providers

`POST /integrations/subscribe` reads a GitHub `resource` as `owner/repo`,
`owner/repo#number`, a pull request's github.com address, or a `/github/…`
path. Linear, Slack and Jira take only a raw path inside the provider's own
Relayfile tree, `/<provider>/…`: native names for them cannot be resolved
without guessing. A path into another provider's tree, a path containing
`..`, or any other spelling is refused. One example each:

| Provider | `resource` |
| --- | --- |
| Linear | `/linear/issues/ENG-123/**` |
| Slack | `/slack/channels/C0123456789/**` |
| Jira | `/jira/issues/ENG-42/**` |

```sh
curl -fsS --unix-socket "$(cat "$HOME/.agentworkforce/desktop/relay-socket")" \
  -H 'Content-Type: application/json' \
  --data '{"provider":"linear","resource":"/linear/issues/ENG-123/**"}' \
  http://relay/integrations/subscribe
```

## REST polling alongside direct injection

Direct injection is additive to a workspace-level REST consumer. The desktop
acknowledges only the delivery queue belonging to the registered session
identity; it does not mark workspace messages read or mutate another
consumer's cursor. A polling integration should use its own identity/cursor,
not the injectable agent token's `/v1/deliveries` queue.

Every injected attribution header includes the canonical Relaycast message id
and a short hash, for example:

```text
[via Agent Relay — from @reviewer to @codex-api · message msg_123 · ref a1b2c3d4e5f6]
```

When a polling MCP and injection can both surface the same workspace message,
deduplicate on that full message id before acting. The short `ref` remains the
reply-correlation marker; it is not the deduplication key.
