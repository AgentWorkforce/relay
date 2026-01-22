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
        const { createRelayClient, runMCPServer, discoverSocket } = await import('./index.js');

        // Discover socket or use default agent name
        const discovery = discoverSocket();
        const agentName = process.env.RELAY_AGENT_NAME || `mcp-${process.pid}`;

        // Create client and run server
        const client = createRelayClient({
          agentName,
          socketPath: discovery?.socketPath,
          project: discovery?.project,
        });

        await runMCPServer(client);
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
