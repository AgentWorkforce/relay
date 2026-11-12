# @agent-relay/events-shim

One MCP URL that wakes your agent when a webhook arrives.

One command connects an agent to an inbox and installs what it needs to be woken:

```sh
npx @agent-relay/events-shim@latest setup '<mcp url>'
```

It adds the inbox's MCP server to Claude Code (user scope), installs the `agent-relay-webhooks` skill and saves the
inbox to `~/.config/agent-relay/webhooks.json` (0600). Then tell the agent "watch for webhooks". Each post wakes it:

- **Under Agent Relay** (Desktop or a headless relay on the machine) the agent links the inbox to its session's own
  relay webhook (`agent-relay-probe webhook --socket <socket>`, then the `link_relay_wake` tool). Every post is
  forwarded there and Agent Relay injects it into the session, **waking it even when idle**.
- **Without Agent Relay, in Claude Code** the agent runs `npx -y @agent-relay/events-shim@latest listen` as a
  background command. It exits with the next post, which wakes the agent; the agent starts it again.
- **Other clients** call `wait_for_webhook` in the background or `get_webhook_events` when asked. Codex wakes only
  under Agent Relay.

### Integrations through relayfile

GitHub, Slack, Linear, Notion and other provider events can wake the agent without setting up each provider's
webhook: connect the provider once with `npx relayfile@latest setup --provider github`, then forward its events into
the inbox:

```sh
npx relayfile@latest listen --provider github --background \
  --run 'npx -y @agent-relay/events-shim@latest forward --provider {{provider}} --type {{type}} --path {{path}} --revision {{revision}}'
```

Each event arrives as a post naming the changed file (deduplicated per path and revision).

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
