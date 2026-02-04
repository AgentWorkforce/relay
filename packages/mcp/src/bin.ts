#!/usr/bin/env node
/**
 * @agent-relay/mcp CLI
 *
 * Main entry point for the MCP package CLI.
 *
 * Usage:
 *   npx @agent-relay/mcp install     - Install MCP server for editors
 *   npx @agent-relay/mcp serve       - Run MCP server (used by editors)
 */

import { parseArgs } from 'node:util';
import { runInstall, validateEditor, getValidEditors } from './install-cli.js';
import { RelayClient } from '@agent-relay/sdk';
import { createRelayClientAdapter } from './client-adapter.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    editor: { type: 'string', short: 'e' },
    global: { type: 'boolean', short: 'g' },
    'dry-run': { type: 'boolean', short: 'n' },
    uninstall: { type: 'boolean', short: 'u' },
    list: { type: 'boolean', short: 'l' },
    status: { type: 'boolean', short: 's' },
    quiet: { type: 'boolean', short: 'q' },
    project: { type: 'string', short: 'p' },
    socket: { type: 'string' },
  },
});

const command = positionals[0];
const VERSION = '0.1.0';

function showHelp(): void {
  console.log(`
@agent-relay/mcp v${VERSION} - MCP Server for Agent Relay

Usage:
  npx @agent-relay/mcp <command> [options]

Commands:
  install     Install MCP server configuration for your editor
  serve       Run the MCP server (used internally by editors)

Install Options:
  -e, --editor <name>   Editor to configure (auto-detect if not specified)
  -g, --global          Install globally (not project-specific)
  -n, --dry-run         Show what would be done without making changes
  -u, --uninstall       Remove MCP server configuration
  -l, --list            List supported editors
  -s, --status          Show installation status
  -q, --quiet           Minimal output

Serve Options:
  -p, --project <path>  Project root path (where .agent-relay lives)
  --socket <path>       Socket path override

Supported Editors:
  ${getValidEditors().join(', ')}

Examples:
  npx @agent-relay/mcp install                    # Auto-detect editors
  npx @agent-relay/mcp install --editor claude    # Claude Desktop only
  npx @agent-relay/mcp install --editor cursor    # Cursor only
  npx @agent-relay/mcp install --global           # Global config
  npx @agent-relay/mcp install --list             # List editors
  npx @agent-relay/mcp install --status           # Show status
  npx @agent-relay/mcp install --uninstall        # Remove config
  npx @agent-relay/mcp serve                      # Run server (for editors)
`);
}

// Handle --help at top level
if (values.help && !command) {
  showHelp();
  process.exit(0);
}

// Handle --version
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}

// No command provided
if (!command) {
  showHelp();
  process.exit(0);
}

// Validate editor if specified
if (values.editor && !validateEditor(values.editor)) {
  console.error(`Error: Unknown editor '${values.editor}'`);
  console.error(`Valid editors: ${getValidEditors().join(', ')}`);
  process.exit(1);
}

switch (command) {
  case 'install':
    runInstall({
      editor: values.editor,
      global: values.global,
      dryRun: values['dry-run'],
      uninstall: values.uninstall,
      list: values.list,
      status: values.status,
      quiet: values.quiet,
    });
    break;

  case 'serve':
    // Dynamic import to avoid loading server code when not needed
    (async () => {
      try {
        const { runMCPServer, discoverSocket, discoverAgentName } = await import('./index.js');
        const { discoverProjectRoot } = await import('./hybrid-client.js');
        const { join } = await import('node:path');
        const { existsSync } = await import('node:fs');

        // Use explicit project path if provided (for MCP servers invoked from different contexts)
        const explicitProject = values.project as string | undefined;
        const explicitSocket = values.socket as string | undefined;

        // If explicit project path provided, derive socket path from it
        let socketPath = explicitSocket;
        let projectRoot = explicitProject;

        if (explicitProject && !explicitSocket) {
          // Derive socket path from project root
          socketPath = join(explicitProject, '.agent-relay', 'relay.sock');
        }

        // Discover socket and agent identity (uses explicit paths if set via env)
        if (socketPath) {
          process.env.RELAY_SOCKET = socketPath;
        }
        const discovery = discoverSocket();
        const agentName = discoverAgentName(discovery) || `mcp-${process.pid}`;

        // Discover project root
        if (!projectRoot) {
          projectRoot = discoverProjectRoot() ?? undefined;
        }

        if (!projectRoot) {
          console.error('Could not find project root (.agent-relay directory)');
          console.error('Use --project <path> to specify the project root explicitly');
          process.exit(1);
        }

        // Verify project root has .agent-relay directory
        const relayDir = join(projectRoot, '.agent-relay');
        if (!existsSync(relayDir)) {
          console.error(`Project root does not have .agent-relay directory: ${projectRoot}`);
          console.error('Run "agent-relay up" in the project to start the daemon first');
          process.exit(1);
        }

        const client = new RelayClient({
          agentName,
          socketPath: socketPath || discovery?.socketPath,
          quiet: values.quiet,
          reconnect: true,
        });

        await client.connect();

        const mcpClient = createRelayClientAdapter(client, {
          agentName,
          project: discovery?.project,
          projectRoot,
          socketPath: socketPath || discovery?.socketPath,
        });

        await runMCPServer(mcpClient, {
          projectRoot,
          project: discovery?.project,
          socketPath: socketPath || discovery?.socketPath,
          agentName,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Failed to start MCP server:', message);
        process.exit(1);
      }
    })();
    break;

  case 'help':
    showHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run with --help for usage');
    process.exit(1);
}
