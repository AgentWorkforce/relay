import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RelayMessage } from '../../../packages/sdk/src/index.js';
import { aiSdkAdapterRegistry } from '../../../packages/harnesses/src/ai-sdk/adapter-registry.js';
import { HarnessHost } from '../../../packages/harnesses/src/ai-sdk/harness-host.js';
import { LocalHostSandboxProvider } from '../../../packages/harnesses/src/ai-sdk/local-host-sandbox.js';
import { NATIVE_RELAY_INSTRUCTIONS } from '../../../packages/harnesses/src/ai-sdk/native-relay-tools.js';
import { RelayHarnessSession } from '../../../packages/harnesses/src/ai-sdk/relay-session.js';

const REAL_MODE = process.env.RELAY_INTEGRATION_REAL_CLI === '1';
const AUTH_OR_CLI_ERROR = /auth|credential|api[-_ ]?key|login|enoent|pnpm/i;

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
        const verifiesRelayReply = entry.name === 'claude' || entry.name === 'codex';
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
            ...(verifiesRelayReply ? { instructions: NATIVE_RELAY_INSTRUCTIONS } : {}),
            ...(verifiesRelayReply
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
          if (verifiesRelayReply) {
            const session = new RelayHarnessSession({
              identity: { id: entry.name, name: entry.name, handle: entry.name },
              host,
            });
            let markSettled!: () => void;
            const settled = new Promise<void>((resolve) => (markSettled = resolve));
            session.onEvent?.((event) => {
              if (event.type === 'turn.settled') markSettled();
            });
            await session.receiveMessage(
              {
                id: 'relay-probe-message',
                messageId: 'relay-probe-message',
                kind: 'dm',
                text: 'Reply to this message with exactly RELAY_CONTRACT_OK.',
                from: { id: 'native-peer', name: 'nativePeer' },
                target: { kind: 'agent', agentName: entry.name },
              } satisfies RelayMessage,
              { id: 'relay-probe-delivery', mode: 'immediate', reason: 'dm' }
            );
            await withTimeout(settled, 120_000);
          } else {
            const turn = await host.startTurn('Reply with exactly RELAY_CONTRACT_OK.');
            await withTimeout(turn.done, 120_000);
          }
          expect(text.join('')).toContain('RELAY_CONTRACT_OK');
          if (verifiesRelayReply) {
            expect(relayToolCalls).toEqual([
              expect.objectContaining({ to: 'nativePeer', text: 'RELAY_CONTRACT_OK' }),
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
