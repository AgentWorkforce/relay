# UCP Integration Specification

## Overview

This spec defines how Agent Relay integrates with Google's Universal Commerce Protocol (UCP) through a workspace-level CLI utility. The `ucp` command enables agents to perform commerce operations (checkout, orders, identity linking, payments) by invoking a simple CLI - the same pattern as `gh`, `trail`, or `agent-relay`.

## Design Philosophy

**Why a CLI, not MCP?**
- Works with any agent (Claude, Codex, Gemini, GPT)
- No protocol complexity - just bash commands
- Familiar pattern for agents already using `gh`, `trail`, etc.
- Easier to test, debug, and script
- Stateless operations with JSON output

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent (Claude, etc.)                   │
│                                                                  │
│   "I need to add this item to the cart"                         │
│                    │                                             │
│                    ▼                                             │
│   $ ucp checkout add-item --merchant shopify --sku ABC123       │
└─────────────────────────────────────────────────────────────────┘
                     │
                     ▼ (subprocess call)
┌─────────────────────────────────────────────────────────────────┐
│                         ucp CLI                                  │
│                    (src/ucp/cli.ts)                             │
│                                                                  │
│  • Parses command and arguments                                 │
│  • Loads merchant credentials from workspace config             │
│  • Makes UCP-compliant HTTP requests                            │
│  • Returns JSON to stdout                                       │
└─────────────────────────────────────────────────────────────────┘
                     │
                     ▼ (HTTPS)
┌─────────────────────────────────────────────────────────────────┐
│                    Merchant UCP Endpoint                         │
│               (Shopify, Stripe, Target, etc.)                   │
│                                                                  │
│  • Receives UCP capability request                              │
│  • Processes commerce action                                    │
│  • Returns UCP-compliant response                               │
└─────────────────────────────────────────────────────────────────┘
```

## CLI Interface

### Installation

```bash
# Installed as part of agent-relay
npm install -g agent-relay

# Available as subcommand or standalone
agent-relay ucp --help
ucp --help  # symlink
```

### Command Structure

```bash
ucp <capability> <action> [options]
```

### Capabilities & Commands

#### 1. Checkout Capability

```bash
# Initialize a checkout session
ucp checkout init --merchant <id> [--user <token>]
# Output: { "sessionId": "...", "cartId": "...", "expiresAt": "..." }

# Add item to cart
ucp checkout add-item --session <id> --sku <sku> --quantity <n> [--variant <id>]
# Output: { "cartId": "...", "items": [...], "subtotal": "..." }

# Remove item from cart
ucp checkout remove-item --session <id> --item-id <id>

# Update item quantity
ucp checkout update-item --session <id> --item-id <id> --quantity <n>

# Get cart contents
ucp checkout cart --session <id>
# Output: { "items": [...], "subtotal": "...", "tax": "...", "total": "..." }

# Calculate taxes (triggers merchant tax calculation)
ucp checkout calculate-tax --session <id> --shipping-address <json>

# Set shipping address
ucp checkout set-shipping --session <id> --address <json>

# Set shipping method
ucp checkout set-shipping-method --session <id> --method <id>

# Get available shipping methods
ucp checkout shipping-methods --session <id>

# Apply discount/promo code
ucp checkout apply-discount --session <id> --code <code>

# Complete checkout (requires payment token)
ucp checkout complete --session <id> --payment-token <token>
# Output: { "orderId": "...", "status": "confirmed", "confirmationNumber": "..." }
```

#### 2. Identity Linking Capability

```bash
# Initiate OAuth flow (returns authorization URL)
ucp identity init --merchant <id> --redirect-uri <uri> [--scope <scopes>]
# Output: { "authUrl": "...", "state": "...", "codeVerifier": "..." }

# Exchange auth code for tokens
ucp identity exchange --merchant <id> --code <code> --state <state> --verifier <v>
# Output: { "accessToken": "...", "refreshToken": "...", "expiresIn": 3600 }

# Refresh access token
ucp identity refresh --merchant <id> --refresh-token <token>

# Revoke access
ucp identity revoke --merchant <id> --token <token>

# Get linked account info
ucp identity info --merchant <id> --token <token>
# Output: { "userId": "...", "email": "...", "name": "..." }
```

#### 3. Order Capability

```bash
# Get order details
ucp order get --merchant <id> --order-id <id> [--token <token>]
# Output: { "orderId": "...", "status": "...", "items": [...], "tracking": [...] }

# List orders (requires identity token)
ucp order list --merchant <id> --token <token> [--limit <n>] [--status <status>]

# Get order tracking
ucp order tracking --merchant <id> --order-id <id>
# Output: { "carrier": "...", "trackingNumber": "...", "events": [...] }

# Initiate return
ucp order return --merchant <id> --order-id <id> --items <json> --reason <reason>

# Cancel order (if cancellable)
ucp order cancel --merchant <id> --order-id <id> [--reason <reason>]
```

#### 4. Payment Token Exchange Capability

```bash
# Get available payment methods for merchant
ucp payment methods --merchant <id>
# Output: { "methods": ["card", "google_pay", "apple_pay", ...] }

# Create payment token from saved credential (Google Pay, etc.)
ucp payment tokenize --merchant <id> --credential <json>
# Output: { "paymentToken": "...", "expiresAt": "..." }

# Validate payment token
ucp payment validate --merchant <id> --token <token>
# Output: { "valid": true, "paymentMethod": "...", "last4": "..." }
```

#### 5. Discovery & Utilities

```bash
# Discover merchant capabilities
ucp discover --merchant <id>
# Output: { "capabilities": ["checkout", "order"], "extensions": ["discounts"] }

# List configured merchants
ucp merchants
# Output: [{ "id": "shopify", "name": "Shopify", "capabilities": [...] }, ...]

# Add/configure merchant
ucp merchants add --id <id> --endpoint <url> --credentials <json>

# Test merchant connection
ucp merchants test --id <id>

# Get UCP spec version
ucp version
# Output: { "cli": "1.0.0", "ucpSpec": "1.0", "supported": ["checkout", "identity", "order", "payment"] }
```

### Global Options

```bash
--format <format>    # Output format: json (default), table, yaml
--quiet              # Suppress non-essential output
--verbose            # Show debug information
--timeout <ms>       # Request timeout (default: 30000)
--config <path>      # Path to config file
--merchant <id>      # Default merchant for all commands
```

## Configuration

### Workspace Configuration

Located at `.agent-relay/ucp.json` or `~/.config/agent-relay/ucp.json`:

```json
{
  "version": "1.0",
  "defaultMerchant": "shopify",
  "merchants": {
    "shopify": {
      "name": "Shopify",
      "endpoint": "https://shop.example.com/.well-known/ucp",
      "capabilities": ["checkout", "order", "identity"],
      "auth": {
        "type": "oauth2",
        "clientId": "...",
        "clientSecret": "$SHOPIFY_CLIENT_SECRET"
      }
    },
    "stripe": {
      "name": "Stripe Payments",
      "endpoint": "https://api.stripe.com/ucp/v1",
      "capabilities": ["payment"],
      "auth": {
        "type": "api_key",
        "key": "$STRIPE_API_KEY"
      }
    }
  },
  "sessions": {
    "directory": ".agent-relay/ucp-sessions",
    "ttl": 3600
  }
}
```

### Environment Variables

```bash
# Merchant credentials (referenced in config with $VAR syntax)
SHOPIFY_CLIENT_SECRET=...
STRIPE_API_KEY=...

# Global settings
UCP_DEFAULT_MERCHANT=shopify
UCP_TIMEOUT=30000
UCP_CONFIG_PATH=...
```

## Session Management

Commerce operations often span multiple commands (add items, set shipping, pay). The CLI manages sessions automatically:

```bash
# Sessions are stored locally and passed between commands
$ ucp checkout init --merchant shopify
{"sessionId": "ucp_sess_abc123", "cartId": "cart_xyz", "expiresAt": "2024-01-15T12:00:00Z"}

# Subsequent commands use the session
$ ucp checkout add-item --session ucp_sess_abc123 --sku PROD-001 --quantity 2

# Sessions auto-expire but can be explicitly cleared
$ ucp checkout abandon --session ucp_sess_abc123
```

Session data stored at `.agent-relay/ucp-sessions/<session-id>.json`:

```json
{
  "id": "ucp_sess_abc123",
  "merchant": "shopify",
  "cartId": "cart_xyz",
  "createdAt": "2024-01-15T10:00:00Z",
  "expiresAt": "2024-01-15T12:00:00Z",
  "state": {
    "items": [...],
    "shippingAddress": {...},
    "shippingMethod": "standard"
  }
}
```

## Agent Integration Patterns

### Pattern 1: Simple Product Purchase

```bash
# Agent performs a purchase flow
$ ucp checkout init --merchant shopify
$ ucp checkout add-item --session $SESSION --sku LAPTOP-PRO --quantity 1
$ ucp checkout set-shipping --session $SESSION --address '{"street":"123 Main","city":"SF","zip":"94102"}'
$ ucp checkout shipping-methods --session $SESSION
$ ucp checkout set-shipping-method --session $SESSION --method standard
$ ucp checkout calculate-tax --session $SESSION
$ ucp checkout complete --session $SESSION --payment-token $PAYMENT_TOKEN
```

### Pattern 2: Multi-Agent Commerce Workflow

```
Lead Agent                    Shopping Agent                 Checkout Agent
    │                              │                              │
    │  "Find me a good laptop"     │                              │
    ├─────────────────────────────►│                              │
    │                              │                              │
    │                    $ ucp discover --merchant amazon          │
    │                    $ ucp checkout init                       │
    │                    [searches, compares]                      │
    │                              │                              │
    │  "Found 3 options, added     │                              │
    │   top pick to cart"          │                              │
    │◄─────────────────────────────┤                              │
    │                              │                              │
    │  "Complete the purchase"     │                              │
    ├──────────────────────────────┼─────────────────────────────►│
    │                              │                              │
    │                              │              $ ucp checkout cart
    │                              │              $ ucp checkout complete
    │                              │                              │
    │  "Order confirmed: #12345"   │                              │
    │◄─────────────────────────────┼──────────────────────────────┤
```

### Pattern 3: Order Monitoring Agent

```bash
#!/bin/bash
# order-monitor.sh - Agent script for tracking orders

while true; do
  orders=$(ucp order list --merchant shopify --token $TOKEN --status pending)

  for order_id in $(echo $orders | jq -r '.orders[].id'); do
    tracking=$(ucp order tracking --merchant shopify --order-id $order_id)

    if echo $tracking | jq -e '.events[-1].status == "delivered"' > /dev/null; then
      echo "Order $order_id delivered!"
      # Notify via relay
      echo "->relay:Lead <<<Order $order_id has been delivered>>>"
    fi
  done

  sleep 300
done
```

## Implementation Plan

### File Structure

```
src/ucp/
├── cli.ts                 # Main CLI entry point (Commander.js)
├── commands/
│   ├── checkout.ts        # Checkout capability commands
│   ├── identity.ts        # Identity linking commands
│   ├── order.ts           # Order capability commands
│   ├── payment.ts         # Payment token commands
│   ├── discover.ts        # Discovery utilities
│   └── merchants.ts       # Merchant management
├── client/
│   ├── http-client.ts     # UCP HTTP client
│   ├── request-builder.ts # Build UCP-compliant requests
│   └── response-parser.ts # Parse UCP responses
├── config/
│   ├── loader.ts          # Load workspace/user config
│   ├── schema.ts          # Config validation
│   └── credentials.ts     # Credential resolution ($ENV vars)
├── session/
│   ├── manager.ts         # Session lifecycle management
│   └── storage.ts         # Local session persistence
├── types/
│   ├── ucp.ts             # UCP protocol types
│   ├── checkout.ts        # Checkout-specific types
│   ├── identity.ts        # Identity-specific types
│   ├── order.ts           # Order-specific types
│   └── payment.ts         # Payment-specific types
└── utils/
    ├── output.ts          # JSON/table/yaml formatting
    └── errors.ts          # Error handling & messages
```

### Package.json Addition

```json
{
  "bin": {
    "agent-relay": "./dist/cli/index.js",
    "ucp": "./dist/ucp/cli.js"
  }
}
```

### Dependencies

```json
{
  "dependencies": {
    "commander": "^11.0.0",      // Already used
    "undici": "^6.0.0",          // HTTP client (or use fetch)
    "zod": "^3.22.0",            // Schema validation
    "conf": "^12.0.0"            // Config management (optional)
  }
}
```

## UCP Protocol Compliance

### Request Format

All requests follow UCP specification:

```http
POST /ucp/v1/checkout/add-item HTTP/1.1
Host: shop.example.com
Content-Type: application/json
Authorization: Bearer <token>
X-UCP-Version: 1.0
X-UCP-Client: agent-relay/1.0.0

{
  "capability": "checkout",
  "action": "add_item",
  "sessionId": "ucp_sess_abc123",
  "payload": {
    "sku": "PROD-001",
    "quantity": 2,
    "variant": null
  }
}
```

### Response Format

```json
{
  "success": true,
  "capability": "checkout",
  "action": "add_item",
  "data": {
    "cartId": "cart_xyz",
    "items": [
      {
        "id": "item_001",
        "sku": "PROD-001",
        "name": "Product Name",
        "quantity": 2,
        "unitPrice": "29.99",
        "totalPrice": "59.98"
      }
    ],
    "subtotal": "59.98",
    "currency": "USD"
  },
  "meta": {
    "requestId": "req_abc",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

### Error Handling

```json
{
  "success": false,
  "error": {
    "code": "ITEM_OUT_OF_STOCK",
    "message": "The requested item is currently out of stock",
    "details": {
      "sku": "PROD-001",
      "availableQuantity": 0
    }
  },
  "meta": {
    "requestId": "req_abc",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

## Security Considerations

### Credential Storage

- Credentials stored in config files reference environment variables
- Never store raw secrets in config files
- Support for credential helpers (like git-credential)

### Session Security

- Sessions are local to the workspace
- Session tokens are not logged
- Sessions auto-expire based on TTL

### Network Security

- All UCP requests use HTTPS
- Certificate validation enabled by default
- Request signing for supported merchants

## Testing Strategy

### Unit Tests

```typescript
// src/ucp/commands/checkout.test.ts
describe('checkout commands', () => {
  it('should initialize checkout session', async () => {
    const result = await runCommand(['checkout', 'init', '--merchant', 'test']);
    expect(result.sessionId).toBeDefined();
  });

  it('should add item to cart', async () => {
    const result = await runCommand([
      'checkout', 'add-item',
      '--session', 'test_session',
      '--sku', 'TEST-001',
      '--quantity', '2'
    ]);
    expect(result.items).toHaveLength(1);
  });
});
```

### Integration Tests

```bash
# Test against UCP sandbox/mock server
UCP_TEST_MODE=sandbox npm test

# Test against real merchant (CI only)
UCP_TEST_MERCHANT=shopify_sandbox npm run test:integration
```

### Mock Server

Include a mock UCP server for local development:

```bash
# Start mock UCP server
ucp mock-server --port 8080

# Configure CLI to use mock
ucp merchants add --id mock --endpoint http://localhost:8080/ucp
```

## Rollout Plan

### Phase 1: Core CLI (Week 1-2)
- [ ] CLI scaffolding with Commander.js
- [ ] Config loading and validation
- [ ] Checkout capability (init, add-item, cart, complete)
- [ ] Basic tests

### Phase 2: Full Capabilities (Week 3-4)
- [ ] Identity linking
- [ ] Order management
- [ ] Payment token exchange
- [ ] Session management

### Phase 3: Polish & Integration (Week 5-6)
- [ ] Mock server for testing
- [ ] Documentation
- [ ] Integration with agent-relay docs (CLAUDE.md snippet)
- [ ] Example workflows

### Phase 4: Real Merchant Testing (Week 7+)
- [ ] Shopify sandbox integration
- [ ] Stripe sandbox integration
- [ ] Production hardening

## Open Questions

1. **Session Sharing**: Should sessions be shareable between agents via relay?
2. **Payment Security**: How do we handle payment tokens securely in a multi-agent context?
3. **Merchant Onboarding**: Self-service vs. curated merchant list?
4. **Rate Limiting**: Per-agent or per-workspace limits for commerce operations?

## References

- [UCP GitHub Repository](https://github.com/universal-commerce-protocol/ucp)
- [UCP Specification](https://ucp.dev/specification/overview)
- [Agent Relay Documentation](../README.md)
