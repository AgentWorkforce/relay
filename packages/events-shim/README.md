# @agent-relay/events-shim

One MCP URL that wakes your agent when a webhook arrives.

One command connects an agent to an inbox and installs what it needs to be woken:

```sh
npx @agent-relay/events-shim@latest setup '<mcp url>'
```

It adds the inbox's MCP server to every supported agent CLI on the machine, or only the ones you name:
`--claude`, `--codex`, `--cursor`, `--opencode`, `--muse`, `--gemini`, `--grok`, `--devin` (or `--cli claude,codex`).
Each tool gets it its own way (`claude`/`codex`/`gemini`/`grok`/`devin`/`muse mcp add` at user scope; Cursor's
`~/.cursor/mcp.json`, opencode's config file), re-running replaces it, and Claude Code and Codex also get
the `agent-relay-webhooks` skill. The inbox is saved to `~/.config/agent-relay/webhooks.json` (0600). Then tell the
agent "watch for webhooks". Each post wakes it:

- **Claude Code, with or without Agent Relay: nothing to do.** `setup --claude` also installs SessionStart and Stop
  hooks (`async`, `asyncRewake`) in `~/.claude/settings.json` that run `events-shim listen --hook`. It waits for the
  next post and exits 2 with it, which wakes the idle session with the post; each turn's Stop hook re-arms it. One
  listener per session, and none for a closed session. `npx @agent-relay/events-shim uninstall --claude` removes it.
- **Codex, with or without Agent Relay Desktop: nothing to do.** `setup --codex` installs a SessionStart hook in
  `~/.codex/hooks.json` (trusted for you) that runs `events-shim link --codex-hook`. On the session's first message
  it creates the session's relay webhook and links the inbox to it, so every post is injected and wakes the idle
  session. It uses Agent Relay Desktop's core when one is running; otherwise setup downloads `agent-relay-node`
  (this release, checksum-verified) to `~/.agentworkforce/events-shim/bin` (replaced when the package updates) and runs it headless on a temporary
  workspace that is deleted after 7 days (setup says when; sign in to Agent Relay to keep one, or set
  `RELAY_WORKSPACE_KEY`). The newest Codex session gets the posts. `uninstall --codex` removes the hook and stops that core. The link is logged to
  `~/.config/agent-relay/events-shim.log`.
- **Devin, Grok, opencode and Muse, the same way.** Their sessions are woken through the same Agent Relay core
  (Desktop's or setup's own). Setup also runs `events-shim serve` as a user service (systemd `--user` on Linux, a
  LaunchAgent on macOS): it keeps the core running and links the inbox to the newest open session of the CLIs you set
  up. A session opened later takes the link, and when the linked one closes the link moves to the most recent one
  still open. Setup turns on opencode's auto-join on its own core, and the core turns on Grok's leader mode, so start
  a new Grok session after setup. `uninstall` stops the service and the core once no CLI uses them.
- **Cursor and Copilot** get a post on their next turn (Agent Relay's hooks); they cannot be woken while idle.
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

| Tool                 | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `watch_webhooks`     | Start here: webhook URLs, wake state, waiting posts and next steps |
| `link_relay_wake`    | Link the session's relay webhook (checked with a test post first)  |
| `unlink_relay_wake`  | Stop forwarding                                                    |
| `get_webhook_events` | Unread posts (marks them read), or one post by id                  |
| `wait_for_webhook`   | Block until a post arrives (≤ 50 s), then return it                |

## Webhook URLs

`<base>/h/<token>` accepts anyone holding the URL. `/github`, `/stripe`, `/linear` and `/bearer` suffixes
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

Pass `deps.defer` (e.g. `ctx.waitUntil`) where background work must be kept alive after the response. A post is
acknowledged before it is forwarded; if the relay fails temporarily, the post is retried in the background and
again on the next post, feed read or `watch_webhooks` call.

Run `recoverStalledWakes({ store, fetchImpl })` on a schedule (every minute is plenty). It re-drains inboxes
whose posts a relay outage left pending, so an idle agent still gets them when no new post arrives. Each run
makes one attempt per inbox; posts younger than 30 seconds are left to their own delivery pass.

Wake links may only point at an allowed Relaycast origin (`relayOrigins`, default
`https://cast.agentrelay.com`), so a holder of the MCP URL cannot make the host post elsewhere.
