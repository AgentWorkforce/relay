# @agent-relay/events-shim

One MCP URL that wakes your agent when a webhook arrives.

A person adds a single MCP server to their agent (`claude mcp add --transport http webhooks <mcp url>`)
and points any sender at the paired webhook URL. Each post becomes an Agent Relay message:

- **Under Agent Relay** the agent links the inbox to its session's own relay webhook
  (`agent-relay-probe webhook --socket <socket>`, then the `link_relay_wake` tool). Every later post is
  forwarded there and Agent Relay injects it into the session, **waking it even when idle**.
- **Without Agent Relay** the agent runs `wait_for_webhook` in the background (it blocks until a post
  arrives) or reads with `get_webhook_events`.

## Tools

| Tool | What it does |
| --- | --- |
| `watch_webhooks` | Start here: webhook URLs, wake state, waiting posts and next steps |
| `link_relay_wake` | Link the session's relay webhook (checked with a test post first) |
| `unlink_relay_wake` | Stop forwarding |
| `get_webhook_events` | Unread posts (marks them read), or one post by id |
| `wait_for_webhook` | Block until a post arrives (≤ 50 s), then return it |

## Webhook URLs

`<base>/h/<token>` accepts anyone holding the URL. `/github`, `/stripe`, `/linear` and `/bearer` suffixes
check the sender against a secret set for that mode. A retried post with the same `Idempotency-Key` (or
the provider's delivery id) arrives once. Limits (`EVENTS_SHIM_LIMITS`): 60 posts/hour, 500/day,
64 KB bodies, 50 posts in the feed, 7 days idle expiry.

## Nudges: wake agents from your own MCP

Post `Content-Type: text/plain` to an authenticated URL (`/bearer`, `/github`, `/stripe`, `/linear`) and the
agent receives exactly that text, e.g. `New task t_42 — read it with get_task on the acme MCP`. Your data stays
behind your MCP; the shim only carries the pointer. Open URLs always wrap the body as untrusted data.

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

Wake links may only point at an allowed Relaycast origin (`relayOrigins`, default
`https://cast.agentrelay.com`), so a holder of the MCP URL cannot make the host post elsewhere.
