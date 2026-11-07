// Add jest-dom matchers for React component testing
import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Machine-wide Agent Relay state (workspace store, Relaycast origin
// bindings) must never land in the real home directory during tests.
if (!process.env.AGENT_RELAY_HOME) {
  process.env.AGENT_RELAY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-test-home-'));
}

const setIfMissing = (key: string, value: string) => {
  if (!process.env[key]) {
    process.env[key] = value;
  }
};

setIfMissing('NODE_ENV', 'test');
setIfMissing('SESSION_SECRET', 'test-session-secret');
setIfMissing('DATABASE_URL', 'postgres://test:test@localhost:5432/test');
setIfMissing('REDIS_URL', 'redis://localhost:6379');
setIfMissing('GITHUB_CLIENT_ID', 'test-github-client-id');
setIfMissing('GITHUB_CLIENT_SECRET', 'test-github-client-secret');
setIfMissing('VAULT_MASTER_KEY', 'test-vault-master-key');
setIfMissing('NANGO_SECRET_KEY', 'test-nango-secret-key');
setIfMissing('STRIPE_SECRET_KEY', 'test-stripe-secret-key');
setIfMissing('STRIPE_PUBLISHABLE_KEY', 'test-stripe-publishable-key');
setIfMissing('STRIPE_WEBHOOK_SECRET', 'test-stripe-webhook-secret');
