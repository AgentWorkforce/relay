import { vi } from 'vitest';

import type { Message, PluginContext, RelayState, ToolDefinition } from '../src/index.js';

interface MockResponse {
  status: number;
  body: unknown;
}

export interface MockRequest {
  endpoint: string;
  body: Record<string, unknown>;
  headers: HeadersInit | undefined;
}

export class MockRelayServer {
  messages: Message[] = [];
  agents: string[] = [];
  requests: MockRequest[] = [];
  responses = new Map<string, MockResponse>();

  injectMessage(from: string, text: string, extra: Partial<Message> = {}): void {
    this.messages.push({
      id: crypto.randomUUID(),
      from,
      text,
      ts: new Date().toISOString(),
      ...extra,
    });
  }

  setResponse(endpoint: string, status: number, body: unknown): void {
    this.responses.set(endpoint, { status, body });
  }

  async handle(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
    switch (endpoint) {
      case 'dm/send':
        this.messages.push({
          id: crypto.randomUUID(),
          from: 'self',
          text: String(body.text ?? ''),
          ts: new Date().toISOString(),
        });
        return { ok: true };
      case 'message/post':
        return { ok: true };
      case 'inbox/check': {
        const queued = [...this.messages];
        this.messages = [];
        return { messages: queued };
      }
      case 'agent/list':
        return { agents: this.agents };
      case 'register':
        return { token: 'test-token-123' };
      case 'agent/add': {
        const name = body.name;
        if (typeof name === 'string' && !this.agents.includes(name)) {
          this.agents.push(name);
        }
        return { ok: true };
      }
      case 'agent/remove': {
        const name = body.name;
        if (typeof name === 'string') {
          this.agents = this.agents.filter((agent) => agent !== name);
        }
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }
}

export function createMockFetch(server: MockRelayServer) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    const endpoint = url.pathname.replace(/^\/api\/v1\//, '');
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};

    server.requests.push({
      endpoint,
      body,
      headers: init?.headers,
    });

    const override = server.responses.get(endpoint);
    if (override) {
      return createResponse(override.body, override.status);
    }

    return createResponse(await server.handle(endpoint, body), 200);
  });
}

export function createPluginContext() {
  const tools = new Map<string, ToolDefinition<unknown, unknown>>();
  const ctx: PluginContext = {
    tool(definition) {
      tools.set(definition.name, definition);
    },
  };

  return { ctx, tools };
}

export function connectRelayState(state: RelayState): RelayState {
  state.agentName = 'Lead';
  state.workspace = 'rk_live_test_workspace';
  state.token = 'test-token-123';
  state.connected = true;
  return state;
}

function createResponse(body: unknown, status: number): Response {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
