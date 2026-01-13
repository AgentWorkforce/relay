/**
 * Custom Storage Adapter Example
 *
 * This example shows a PostgreSQL storage adapter.
 * Modify for your database of choice.
 */

import { Daemon, getProjectPaths } from 'agent-relay';
import { PostgresStorageAdapter } from './postgres-adapter.js';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable required');
    process.exit(1);
  }

  // Create custom storage adapter
  const storage = new PostgresStorageAdapter(databaseUrl, {
    poolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
  });

  // Initialize storage (creates tables)
  await storage.init();
  console.log('Storage initialized');

  // Create daemon with custom storage
  const paths = getProjectPaths();
  const daemon = new Daemon({
    socketPath: process.env.AGENT_RELAY_SOCKET || paths.socketPath,
    storage,
  });

  await daemon.start();
  console.log('Daemon started with PostgreSQL storage');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await daemon.stop();
    await storage.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
