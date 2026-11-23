# @agent-relay/events-shim

One MCP URL that wakes your agent when a webhook arrives.

One command connects an agent to an inbox and installs what it needs to be woken:

```sh
npx @agent-relay/events-shim@latest setup '<mcp url>'
```

It adds the inbox's MCP server to every supported agent CLI on the machine, or only the ones you name:
`--claude`, `--codex`, `--copilot`, `--cursor`, `--droid`, `--amp`, `--opencode`, `--muse`, `--gemini`, `--grok`, `--devin` (or `--cli claude,codex`).
Each tool gets it its own way (`claude`/`codex`/`copilot`/`droid`/`amp`/`gemini`/`grok`/`devin`/`muse mcp add` at user scope; Cursor's
`~/.cursor/mcp.json`, opencode's config file), re-running replaces it, and Claude Code and Codex also get
the `agent-relay-webhooks` skill. The inbox is saved to `~/.config/agent-relay/webhooks.json` (0600), per CLI. Then tell the
agent "watch for webhooks". Each post wakes it:

**One inbox wakes one session, not one per agent.** To wake Claude Code and Codex (or any two agents) independently,
make one inbox per agent and run `setup` once per agent with its own MCP URL (`setup '<inbox A>' --claude`, then
`setup '<inbox B>' --codex`). Each CLI keeps the inbox it was set up with. Setup refuses to add a second waking CLI to
an inbox another CLI already uses, or to an inbox linked to another agent's session, unless you pass `--share-inbox`.
When CLIs share an inbox, setup says which session gets the posts: a relay wake link (Codex and the other CLIs woken
through the core) takes every post while it works, and otherwise the hook listeners do.

- **Claude Code, with or without Agent Relay: nothing to do.** `setup --claude` also installs SessionStart and Stop
  hooks (`async`, `asyncRewake`) in `~/.claude/settings.json` that run `events-shim listen --hook`. It waits for the
  next post and exits 2 with it, which wakes the idle session with the post; each turn's Stop hook re-arms it. One
  listener per session, and none for a closed session. The hooks run in every Claude Code session, but the inbox
  wakes one: the most recently started session takes it over at its start (not a `claude -p` run or a compaction),
  and the older session's listener stops before it takes another post. A session that calls a `webhooks` MCP tool
  (`watch_webhooks`, `link_relay_wake`, `wait_for_webhook`, `get_webhook_events`, `ack_webhook_events` or
  `release_webhook_events`) takes it over too, so telling an older session "watch for webhooks" moves the posts to
  it. When the owning session closes, the next session to start or finish a turn takes over. While the inbox has a working relay wake link
  (`link_relay_wake`), no hook listener takes posts: the link delivers each one to the session that made it.
  `npx @agent-relay/events-shim uninstall --claude` removes the hooks.
- **Codex, with or without Agent Relay Desktop: nothing to do.** `setup --codex` installs a SessionStart hook in
  `~/.codex/hooks.json` (trusted for you) that runs `events-shim link --codex-hook`. On the session's first message
  it creates the session's relay webhook and links the inbox to it, so every post is injected and wakes the idle
  session. It uses Agent Relay Desktop's core when one is running; otherwise setup downloads `agent-relay-node`
  (this release, checksum-verified) to `~/.agentworkforce/events-shim/bin` (replaced when the package updates) and runs it headless on a temporary
  workspace that is deleted after 7 days (setup says when; sign in to Agent Relay to keep one, or set
  `RELAY_WORKSPACE_KEY`). The newest Codex session gets the posts. `uninstall --codex` removes the hook and stops that core. The link is logged to
  `~/.config/agent-relay/events-shim.log`.
  **The session has to be started:** open Codex and send it a first message, such as "Watch for webhooks".
  Codex creates a session only on its first turn, so a new window with no message yet cannot be woken (even
  `codex queue` refuses it).
- **Devin, Grok and opencode, the same way** (Muse is linked too, but Agent Relay cannot deliver into a Muse session yet, relay#2174; until then its agent reads posts when asked). Their sessions are woken through the same Agent Relay core
  (Desktop's or setup's own). Setup also runs `events-shim serve` as a user service (systemd `--user` on Linux, a
  LaunchAgent on macOS): it keeps the core running and links the inbox to the newest open session of the CLIs you set
  up. A session opened later takes the link, and when the linked one closes the link moves to the most recent one
  still open. Setup turns on opencode's auto-join on its own core, and the core turns on Grok's leader mode, so start
  a new Grok session after setup. `uninstall` stops the service and the core once no CLI uses them.
- **GitHub Copilot CLI and Gemini CLI, with or without Agent Relay.** `setup --copilot` writes an `agentStop` hook to
  `~/.copilot/hooks/agent-relay-webhooks.json` (`COPILOT_HOME` respected); `setup --gemini` adds an `AfterAgent` hook to
  `~/.gemini/settings.json`, keeping your own hooks. Both run `events-shim listen --stop-hook <cli>` with a 7-day
  timeout. When a turn ends, the hook waits for the next post and answers with it as the agent's next prompt
  (Copilot `decision: "block"`, Gemini `decision: "deny"`), so the session takes a new turn by itself; each turn
  re-arms it. **Send the session a first message**: it can be woken only once it has finished a turn. While it waits
  the CLI shows its turn as running ("Working" / "Executing Hook") and holds what you type, so press Ctrl+C
  (Copilot) or Esc (Gemini) first; the hook sees that in the session's transcript and lets go, and it waits again
  after your turn. Copilot continues a turn from a hook at most 8 times in a row, so after 8 posts with no message from
  you the session stops waking until you send it one (the 8th post tells the agent to ask you). Beside Agent Relay's
  Gemini extension (installed, enabled and signed in), the hook still waits for posts, and lets go at once when the
  extension's Relay Stop Guard continues the turn with relay messages, so those are not kept waiting. `uninstall --copilot` / `--gemini` removes the hook and stops a waiting one.
- **Factory Droid, Cursor CLI and Amp, with or without Agent Relay, the same way.** `setup --droid` adds a `Stop` hook
  (7-day timeout) to `~/.factory/hooks.json`, or to the `hooks` key of `~/.factory/settings.json` while hooks.json is
  absent (Droid then reads only settings.json, so your hooks there keep working), and answers `decision: "block"`.
  `setup --cursor` adds a `stop` hook to `~/.cursor/hooks.json` (`loop_limit: null`) that answers `followup_message`;
  Cursor ends a hook after an hour, so a Cursor session idle for longer than an hour after its last turn is not woken
  until you send it a message. `setup --amp` writes the plugin `~/.config/amp/plugins/agent-relay-webhooks.ts`: after
  each turn its `agent.end` handler runs `listen --stop-hook amp` and starts the next turn with the post
  (`action: "continue"`); older Amp builds load plugins only with `PLUGINS=all` set. **Send each a first message.**
  While it waits, Droid shows "Streaming..." and keeps what you type for after the next post, so press Esc first;
  Amp also shows "Streaming", and starting a turn yourself stops the wait (a post it had already taken comes after
  your turn). Cursor's prompt stays usable. Cursor waits for every `stop` hook before it submits a follow-up, so while
  Agent Relay's own Cursor CLI delivery is on (its `cursor-hook --wait` entry), events-shim's Cursor hook never holds
  the turn and the agent reads posts when asked; setup says so. `uninstall --droid` / `--cursor` / `--amp` removes them.
- **Replicas and Capy** run their agents in the cloud (the desktop apps are clients), so there is no local session to
  wake; Agent Relay connects their cloud chats and threads instead (`bind_replica`, `bind_capy_thread`).
- **Under Agent Relay** (Desktop or a headless relay on the machine) the agent links the inbox to its session's own
  relay webhook (`agent-relay-probe webhook --socket <socket>`, then the `link_relay_wake` tool). Every post is
  forwarded there and Agent Relay injects it into the session, **waking it even when idle**.
- **Without Agent Relay, in Claude Code** the agent runs `npx -y @agent-relay/events-shim@latest listen` as a
  background command. It exits with the next post, which wakes the agent; the agent starts it again.
- **Other clients** call `wait_for_webhook` in the background or `get_webhook_events` when asked.

### Integrations through relayfile

GitHub, Slack, Linear, Notion and other provider events can wake the agent without setting up each provider's
webhook: connect the provider once with `npx relayfile@latest setup --provider github`, then forward its events into
the inbox:

```sh
npx relayfile@latest listen --path '/github/**' --background \
  --run 'npx -y @agent-relay/events-shim@latest forward --stdin'
```

Filter by path: relayfile's events do not carry the provider, so `--provider` matches none of them. relayfile hands
each event to `forward` as JSON on stdin, so no event field is ever put into a shell command. Each
event arrives as a post naming the changed file (deduplicated per path and revision).

## Tools

| Tool                     | What it does                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `watch_webhooks`         | Start here: webhook URLs, wake state and the agent a link wakes, waiting posts      |
| `link_relay_wake`        | Link the session's relay webhook (checked first); pass `agent`, your relay name     |
| `unlink_relay_wake`      | Stop forwarding                                                                     |
| `get_webhook_events`     | Unread posts (marks them read), or one post by id                                   |
| `wait_for_webhook`       | Block until a post arrives (≤ 50 s), then return it (marks it read, or leases it)   |
| `ack_webhook_events`     | Mark posts a leased `wait_for_webhook` returned read (`ids` + `claim_token`)        |
| `release_webhook_events` | Give posts a leased `wait_for_webhook` returned back unread (`ids` + `claim_token`) |

### Leased waits

`wait_for_webhook` marks the posts it returns read, unless it is called with `auto_ack: false` (the default when
`ack_ids` is passed). Then the posts stay unread under a lease: the result carries a `claim_token` (and
`claimed_at`), and for 2 minutes (`sendLeaseMs`) no other wait takes them. The caller then either

- acknowledges them once handled: `ack_webhook_events` with their `ids` and `claim_token`, or the next
  `wait_for_webhook` call's `ack_ids` and `ack_claim_token`;
- or releases them: `release_webhook_events` with `ids` and `claim_token`, so the next wait takes them at once.

Posts neither acknowledged nor released are offered again once the lease ends, so a listener that dies between
claiming and handing a post over no longer loses it (delivery is at least once: a post whose acknowledgement was
lost arrives again). Only the claimant can settle a lease: both tools need the `claim_token` of the current claim,
a stale token (the lease ended and another wait took the posts) changes nothing, and they never touch unclaimed
posts or posts a relay wake link is forwarding. The `claim_token` appears only in that `wait_for_webhook` result,
never in the feed or `get_webhook_events`. A wait whose client leaves while it claims gives the posts back at once.
While a relay wake link works, a leased wait takes nothing either.

The CLI's listeners (`listen`, `--hook`, `--stop-hook`) wait with `auto_ack: false`: they acknowledge a batch once
it is handed to the session (or printed), and release it when the session let go first. Against an inbox without
leases (no `claim_token` in the result, see Hosting) they keep the older behaviour: the posts are already read,
and a stop hook that let go keeps the post on disk for the next turn's hook.

### Which session a link wakes

Every session that has the inbox's MCP server reads the same wake state, so `watch_webhooks` names the Agent Relay
agent a working link wakes (`linked_agent`, with `linked_at`) and tells the agent to compare it with its own name
before saying the inbox is linked to it. `link_relay_wake` records its `agent` argument (events-shim's own links for
Codex and the other CLIs woken through the core always pass it) and answers `replaced_agent` when it moves the link
away from another session. A link made without a name is reported as `linked_agent: null`, and the agent is told to
assume it wakes another session unless it made the link itself. Hosts keep the name in `WakeTarget.agent`. The page
feed shows it as `agent.wake_agent`.

## Webhook URLs

`<base>/h/<token>` accepts anyone holding the URL. `/github`, `/stripe`, `/linear`, `/bearer` and `/mcp` suffixes
check the sender against a secret set for that mode. Limits (`EVENTS_SHIM_LIMITS`): 60 posts/hour,
500/day, 64 KB bodies, 50 posts in the feed, 7 days idle expiry. The 50-post limit covers unread posts
too: if more than 50 arrive before the agent links or reads the inbox, the oldest are dropped for good.

Deduplication: a repeated post arrives once for 24 hours (`dedupeWindowMs`), keyed by

- Stripe: the event `id` in the signed body;
- GitHub and Linear: a hash of the signed body (a redelivery resends the same body), so two distinct
  deliveries with byte-identical bodies also collapse into one;
- bearer and open: the sender's `Idempotency-Key` header, separately per URL (keys over 200 characters are
  hashed whole); posts without one are never deduplicated.

Duplicates still count toward the rate limits. A new post answers `202` (`200` on `/linear`, since Linear
retries anything else); a duplicate answers `200` with `"duplicate": true` on every URL. Treat any 2xx as
accepted.

## Nudges: wake agents from your own MCP

Post `Content-Type: text/plain` to an authenticated URL (`/bearer`, `/github`, `/stripe`, `/linear`) and the
agent receives that text as the whole message, e.g. `New task t_42 — read it with get_task on the acme MCP`.
Your data stays behind your MCP; the shim only carries the pointer. Limits:

- Surrounding whitespace is trimmed, and text over 6,000 characters (`wakePreviewChars`) is cut off with a
  note telling the agent to read the rest with `get_webhook_events` and the post's id.
- On `/github`, `/stripe` and `/linear` the signature covers the body but not `Content-Type`, so a body that
  looks like a provider event (JSON, or `payload=…`) is always wrapped as untrusted data, whatever its
  header says. Plain text from a signing vendor is delivered as is. `/bearer` has no such check.
- Open URLs always wrap the body as untrusted data.

## MCP Events

The MCP URL also speaks the MCP Events extension (`io.modelcontextprotocol/events`, SEP-3415). It is advertised in
`initialize`, so a client with Events support reads posts without the tools above:

- **`events/list`** offers one type, `webhook.received`. Its optional arguments are `event_type` (exact, or a prefix
  ending in `*`, such as `pull_request.*`) and `mode` (`open`, `github`, …).
- **`events/poll`** takes a cursor (`null` means from now). It answers `events`, a cursor scoped to this inbox,
  `truncated`, `hasMore` and `nextPollMs`. `truncated: true` means delivery starts later than your cursor: posts
  after it already left the 50-post feed, the `maxAgeMs` floor skipped some, or the cursor was not issued by this
  inbox. `maxAgeMs` bounds a cursor replay and is ignored with a `null` cursor.
- **`events/stream`** answers with an SSE stream:
  - It opens with `notifications/events/active` (whose cursor is the position before the replay), replays posts
    after the cursor, then sends each new post as `notifications/events/event`, plus heartbeats (5–60 s).
  - If posts leave the feed between reads it sends a fresh `active` with `truncated: true` and carries on. A
    failed store read is a recoverable `notifications/events/error`.
  - After `eventsStream.maxStreamMs` (5 minutes by default) it ends with a final result. Send `events/stream` again
    with the last cursor.
- **`events/subscribe`** answers `Unsupported`: this type is offered by poll and push only.

Events reads move only the client's cursor. They do not mark posts read or claim them, so a session that uses
Events should not also link a relay wake or run a listener on the same inbox, or it sees each post twice.

### Receiving MCP Events webhooks

The `mcp` URL (`/h/<token>/mcp`) receives an MCP server's Events webhook deliveries:

1. `PUT /shims/current/secrets/mcp` with `{}`. The response has a generated `whsec_…` secret, shown once.
2. Subscribe on the MCP server with `delivery: { mode: "webhook", url: <the mcp URL>, secret: <that secret> }`.
3. The server's signed verification challenge is answered by the inbox.
4. Each delivery is checked (Standard Webhooks `webhook-signature`, any one `v1,` entry, within 5 minutes),
   deduplicated by `webhook-id`, and wakes the agent like any other post. Its event type is the Events `name`.

`gap` and `terminated` envelopes arrive as `mcp.events.gap` and `mcp.events.terminated` posts that say what
happened. Hosts can publish `/.well-known/mcp-webhook-receiver.json` by passing `mcpWebhookReceivers` (the path
prefixes of their `/h/` URLs) and routing that path to the handler.

## Hosting

Hosts implement `EventsShimStore` (see `MemoryEventsShimStore`) and mount one handler:

```ts
import { handleEventsShimRequest } from '@agent-relay/events-shim';

const response = await handleEventsShimRequest(request, pathAfterMount, {
  deps: { store, fetchImpl: fetch },
  urls: {
    mcpUrl: (token) => `${base}/t/${token}/mcp`,
    hookUrl: (token, mode) => `${base}/h/${token}${mode === 'open' ? '' : `/${mode}`}`,
  },
  beforeCreate: perIpRateLimit,
});
```

Create an inbox with `POST <mount>/shims`. It answers once with `mcp_url`, `webhook_urls` and a
`manage_token`; keep the manage token, since only hashes are stored. With
`Authorization: Bearer <manage_token>`:

- `GET /shims/current` reads the feed, URLs and wake state;
- `PUT /shims/current/secrets/<github|stripe|linear|bearer>` with `{"secret": "…"}` sets the secret an
  authenticated URL checks (for `bearer`, send `{}` to have one generated and returned once; `null` removes it);
- `POST /shims/current/rotate` replaces the webhook URL.

Leases are optional for a host. `ackPending` and `releasePending` on `EventsShimStore` are optional methods; a
store that implements both also stores `claimToken` when `claimPending` is called with `state: 'pending'`, and
treats a `pending` post with a `deliveredAt` newer than `staleBefore` as leased (not claimable, not counted by
`countPending`). Only then does the inbox lease `wait_for_webhook` claims and offer `ack_webhook_events` and
`release_webhook_events`. A store without them never sees a `'pending'` claim: `wait_for_webhook` marks posts read
as before, `auto_ack` and `ack_ids` are ignored, and the CLI listeners fall back as described above.

Pass `deps.defer` (e.g. `ctx.waitUntil`) where background work must be kept alive after the response. A post is
acknowledged before it is forwarded; if the relay fails temporarily, the post is retried in the background and
again on the next post, feed read or `watch_webhooks` call.

Run `recoverStalledWakes({ store, fetchImpl })` on a schedule (every minute is plenty). It re-drains inboxes
whose posts a relay outage left pending, so an idle agent still gets them when no new post arrives. Each run
makes one attempt per inbox; posts younger than 30 seconds are left to their own delivery pass.

Wake links may only point at an allowed Relaycast origin (`relayOrigins`, default
`https://cast.agentrelay.com`), so a holder of the MCP URL cannot make the host post elsewhere.
