/**
 * Programmatic Usage Examples
 *
 * These examples show how to use agent-relay as a library
 * in your own Node.js/TypeScript applications.
 */

import { Daemon } from 'agent-relay';
import { RelayClient } from 'agent-relay';
import { TmuxWrapper } from 'agent-relay';
import { getProjectPaths, ensureProjectDir } from 'agent-relay';

// ============================================
// Example 1: Start a daemon programmatically
// ============================================

async function startDaemon() {
  const paths = ensureProjectDir();

  const daemon = new Daemon({
    socketPath: paths.socketPath,
    storagePath: paths.dbPath,
  });

  await daemon.start();
  console.log(`Daemon running on ${paths.socketPath}`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });
}

// ============================================
// Example 2: Connect as a client
// ============================================

async function connectAsClient() {
  const paths = getProjectPaths();

  const client = new RelayClient({
    name: 'MyAgent',
    socketPath: paths.socketPath,
  });

  // Handle incoming messages
  client.on('message', (msg) => {
    console.log(`Received from ${msg.from}: ${msg.body}`);
  });

  await client.connect();

  // Send a message
  await client.send({
    to: 'OtherAgent',
    body: 'Hello from MyAgent!',
  });

  // Broadcast to all
  await client.broadcast('Hello everyone!');
}

// ============================================
// Example 3: Wrap a command with TmuxWrapper
// ============================================

async function wrapCommand() {
  const paths = getProjectPaths();

  const wrapper = new TmuxWrapper({
    name: 'Claude',
    command: 'claude',
    args: [],
    socketPath: paths.socketPath,
    debug: false,
    useInbox: true,
    inboxDir: paths.dataDir,
  });

  process.on('SIGINT', () => {
    wrapper.stop();
    process.exit(0);
  });

  await wrapper.start();
}

// ============================================
// Example 4: Custom project paths
// ============================================

function customPaths() {
  // Get paths for current directory
  const currentPaths = getProjectPaths();
  console.log('Current project:', currentPaths);

  // Get paths for a specific project root
  const customPaths = getProjectPaths('/path/to/my/project');
  console.log('Custom project:', customPaths);

  // ProjectPaths structure:
  // {
  //   dataDir: string;      // Root directory for project data
  //   teamDir: string;      // Team data directory
  //   dbPath: string;       // SQLite database path
  //   socketPath: string;   // Unix socket path
  //   projectRoot: string;  // The project root used
  //   projectId: string;    // Short hash identifier
  // }
}

// ============================================
// Example 5: Environment-based configuration
// ============================================

function envConfig() {
  // Set environment variables before importing agent-relay
  process.env.AGENT_RELAY_DATA_DIR = '/custom/data/dir';
  process.env.AGENT_RELAY_DASHBOARD_PORT = '4000';
  process.env.AGENT_RELAY_SQLITE_DRIVER = 'node';

  // Now paths will use the custom data directory
  const paths = getProjectPaths();
  console.log(paths.dataDir); // /custom/data/dir/<project-hash>
}
