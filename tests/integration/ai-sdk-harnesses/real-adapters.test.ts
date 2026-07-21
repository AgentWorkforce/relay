import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiSdkAdapterRegistry } from '../../../packages/harnesses/src/ai-sdk/adapter-registry.js';
import { HarnessHost } from '../../../packages/harnesses/src/ai-sdk/harness-host.js';
import { LocalHostSandboxProvider } from '../../../packages/harnesses/src/ai-sdk/local-host-sandbox.js';
import { NATIVE_RELAY_INSTRUCTIONS } from '../../../packages/harnesses/src/ai-sdk/native-relay-tools.js';

const REAL_MODE = process.env.RELAY_INTEGRATION_REAL_CLI === '1';
const AUTH_OR_CLI_ERROR = /auth|credential|api[-_ ]?key|login|not found|unavailable|enoent|pnpm/i;

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('real adapter turn timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('real AI SDK adapters (explicit opt-in)', () => {
  for (const entry of aiSdkAdapterRegistry.list()) {
    it.skipIf(!REAL_MODE)(
      `real adapter ${entry.name}: create, turn, and cleanup`,
      async (context) => {
        const root = await mkdtemp(join(tmpdir(), `relay-real-${entry.name}-`));
        const workspace = join(root, 'workspace');
        const provider = new LocalHostSandboxProvider({
          workspace,
          runtimeRoot: join(root, 'runtime'),
          gracefulShutdownMs: 100,
        });
        let host: HarnessHost | undefined;
        try {
          const preflight = await provider.preflight();
          if (!preflight.ok) {
            context.skip(`adapter ${entry.name} unavailable: local host preflight failed`);
            return;
          }
          const harness = await entry.createHarness();
          const text: string[] = [];
          const relayToolCalls: unknown[] = [];
          host = new HarnessHost({
            harness,
            sandboxProvider: provider,
            workspace,
            ...(entry.name === 'codex' ? { instructions: NATIVE_RELAY_INSTRUCTIONS } : {}),
            ...(entry.name === 'codex'
              ? {
                  tools: [
                    {
                      spec: {
                        name: 'send_dm',
                        description: 'Send a direct message to another Relay agent.',
                        inputSchema: {
                          type: 'object' as const,
                          properties: {
                            to: { type: 'string' as const },
                            text: { type: 'string' as const },
                          },
                          required: ['to', 'text'],
                          additionalProperties: false,
                        },
                      },
                      execute: (input: unknown) => {
                        relayToolCalls.push(input);
                        return { delivered: true };
                      },
                    },
                  ],
                }
              : {}),
          });
          host.onEvent((event) => {
            if (event.type === 'text.delta') text.push(String(event.delta));
          });
          await host.start();
          const turn = await host.startTurn(
            entry.name === 'codex'
              ? 'Send nativeClaude the text RELAY_TOOL_PROBE. After it succeeds, reply with exactly RELAY_CONTRACT_OK.'
              : 'Reply with exactly RELAY_CONTRACT_OK.'
          );
          await withTimeout(turn.done, 120_000);
          expect(text.join('')).toContain('RELAY_CONTRACT_OK');
          if (entry.name === 'codex') {
            expect(relayToolCalls).toEqual([
              expect.objectContaining({ to: 'nativeClaude', text: 'RELAY_TOOL_PROBE' }),
            ]);
          }
        } catch (error) {
          const detail =
            error instanceof Error ? `${error.message}\n${String(error.cause ?? '')}` : String(error);
          if (AUTH_OR_CLI_ERROR.test(detail)) {
            context.skip(`adapter ${entry.name} unavailable: CLI or credentials`);
            return;
          }
          throw error;
        } finally {
          await host?.destroy().catch(() => undefined);
          await rm(root, { recursive: true, force: true });
        }
      },
      180_000
    );
  }
});
