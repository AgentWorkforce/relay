import { createInterface } from 'node:readline';
import { getToolDefinitions, handleToolCall, cleanup } from './tools.js';

/**
 * MCP stdio server — JSON-RPC 2.0 transport over stdin/stdout.
 *
 * Exposes spawn_openclaw, list_openclaws, release_openclaw tools.
 * Registered in openclaw.json as "openclaw-spawner" MCP server.
 */
export async function startMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    let request: {
      jsonrpc: string;
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };

    try {
      request = JSON.parse(line);
    } catch {
      writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize': {
          writeResponse({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: 'openclaw-spawner',
                version: '1.0.0',
              },
            },
          });
          break;
        }

        case 'notifications/initialized': {
          // No response needed for notifications
          break;
        }

        case 'tools/list': {
          const tools = getToolDefinitions();
          writeResponse({
            jsonrpc: '2.0',
            id,
            result: { tools },
          });
          break;
        }

        case 'tools/call': {
          const toolName = (params?.name as string) ?? '';
          const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
          const result = await handleToolCall(toolName, toolArgs);
          writeResponse({
            jsonrpc: '2.0',
            id,
            result,
          });
          break;
        }

        default: {
          writeResponse({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
        }
      }
    } catch (err) {
      writeResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  rl.on('close', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  process.stderr.write('[openclaw-spawner] MCP server started (stdio)\n');
}

function writeResponse(response: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}
