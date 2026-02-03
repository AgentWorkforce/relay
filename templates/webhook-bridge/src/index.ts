/**
 * Webhook Bridge for Agent Relay
 *
 * - Receives HTTP webhooks → broadcasts to agents
 * - Agent messages with webhookUrl → sends outgoing webhooks
 */

import express from 'express';
import { WebhookBridge } from './bridge.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const bridge = new WebhookBridge({
    name: process.env.BRIDGE_NAME || 'WebhookBridge',
    secret: process.env.WEBHOOK_SECRET,
  });

  await bridge.connect();

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      connected: bridge.isConnected(),
      timestamp: Date.now(),
    });
  });

  // Receive webhooks
  app.post('/webhook', (req, res) => bridge.handleWebhook(req, res));
  app.post('/webhook/:topic', (req, res) => bridge.handleWebhook(req, res));

  // Graceful shutdown
  const server = app.listen(PORT, HOST, () => {
    console.log(`Webhook Bridge listening on http://${HOST}:${PORT}`);
    console.log('Endpoints:');
    console.log('  POST /webhook       - Receive webhooks');
    console.log('  POST /webhook/:topic - Receive with topic');
    console.log('  GET  /health        - Health check');
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    server.close();
    await bridge.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
