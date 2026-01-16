# Webhook Bridge for Agent Relay

Receive HTTP webhooks and broadcast to agents. Send agent messages as outgoing webhooks.

## Use Cases

- **CI/CD Integration** - GitHub Actions, CircleCI, Jenkins
- **Monitoring Alerts** - PagerDuty, Datadog, Sentry
- **External Services** - Stripe, Twilio, custom APIs
- **Serverless Triggers** - Connect serverless functions to agents

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

## Endpoints

### Receive Webhooks

```
POST /webhook
POST /webhook/:topic

# With optional query params
POST /webhook?to=Alice&thread=issue-123
```

All incoming webhooks are broadcast to agents (or sent to specific agent via `?to=`).

### Send Webhooks

Agents can trigger outgoing webhooks by sending to the bridge with a `webhookUrl` in data:

```
->relay:WebhookBridge <<<
{"event": "deploy_complete", "status": "success"}
{"webhookUrl": "https://api.example.com/callback"}>>>
```

### Health Check

```
GET /health
```

## Webhook Format

### Incoming (POST /webhook)

```json
{
  "event": "push",
  "repository": "my-repo",
  "branch": "main"
}
```

Becomes agent message:
```
From: WebhookBridge
Body: {"event": "push", "repository": "my-repo", "branch": "main"}
Data: { source: "webhook", topic: "github" }
```

### Outgoing

When agent sends with `webhookUrl` in data, bridge POSTs:

```json
{
  "from": "DeployAgent",
  "body": "Deployment complete",
  "data": { ... },
  "timestamp": 1234567890
}
```

## Security

### Webhook Secret Validation

Set `WEBHOOK_SECRET` and include `X-Webhook-Signature` header:

```bash
# Generate signature
echo -n '{"event":"test"}' | openssl dgst -sha256 -hmac "your-secret"
```

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=..." \
  -d '{"event":"test"}'
```

### IP Allowlisting

Edit `src/middleware.ts` to add IP restrictions.

## Examples

### GitHub Webhook

```bash
# In GitHub repo settings, add webhook:
# URL: https://your-server.com/webhook/github
# Content-Type: application/json
# Secret: your-webhook-secret
```

### Stripe Webhook

```bash
curl -X POST http://localhost:3000/webhook/stripe \
  -H "Content-Type: application/json" \
  -d '{"type":"payment.succeeded","data":{"amount":1000}}'
```

### Custom Trigger

```bash
curl -X POST "http://localhost:3000/webhook?to=DeployAgent&thread=deploy-123" \
  -H "Content-Type: application/json" \
  -d '{"action":"deploy","env":"staging"}'
```
