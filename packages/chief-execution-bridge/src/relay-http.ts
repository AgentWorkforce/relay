import { z } from 'zod';
import {
  RelayError,
  type RelayConversation,
  type RelayIdentity,
  type RelayMessage,
  type RelayPort,
  type SendReport,
  type SpawnReceipt,
  type SpawnRequest,
} from './ports.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const envelope = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data });

const IDENTITY_SCHEMA = envelope(
  z.object({ id: z.string().min(1), workspace_id: z.string().min(1), address: z.string().optional() })
);
const CONVERSATIONS_SCHEMA = envelope(
  z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(['1:1', 'group']),
      participants: z.array(z.object({ agent_id: z.string().min(1) })),
      last_message: z.object({ id: z.string().min(1) }).nullish(),
    })
  )
);
const MESSAGES_SCHEMA = envelope(
  z.array(
    z.object({
      // Snowflakes are decimal text of varying length: 18 digits until 2032.
      id: z.string().regex(/^\d{1,20}$/),
      agent_id: z.string().min(1),
      agent_name: z.string().min(1),
      text: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      created_at: z.string().optional(),
    })
  )
);
const RECEIPT_SCHEMA = envelope(
  z.object({
    invocation_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    status: z.enum(['pending', 'dispatched', 'invoked', 'running', 'completed', 'failed', 'denied']),
    dispatched_node_id: z.string().nullish(),
    handler_node_id: z.string().nullish(),
    output: z.unknown().optional(),
  })
);

function toReceipt(raw: z.infer<typeof RECEIPT_SCHEMA>['data']): SpawnReceipt {
  const id = raw.invocation_id ?? raw.id;
  if (!id) throw new RelayError('relay_response_invalid', true);
  const output = (typeof raw.output === 'object' && raw.output !== null ? raw.output : {}) as Record<
    string,
    unknown
  >;
  const warning = output.warning as { code?: unknown } | string | undefined;
  return {
    id,
    status: raw.status === 'denied' ? 'failed' : raw.status,
    nodeId: raw.dispatched_node_id ?? raw.handler_node_id ?? undefined,
    name: typeof output.name === 'string' ? output.name : undefined,
    // Exactly true, as the core reads them.
    spawned: output.spawned === true,
    ready: output.ready === true,
    taskUnconfirmed:
      warning === 'spawn_task_unconfirmed' ||
      (typeof warning === 'object' && warning?.code === 'spawn_task_unconfirmed'),
  };
}

/**
 * Relaycast over HTTP with the worker's agent token only. Errors carry a code derived from
 * the status; response bodies and the token are never logged or put in an error.
 */
export class RelayHttpClient implements RelayPort {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!token.trim()) throw new Error('relay_token_missing');
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown; key?: string } = {}
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.origin), {
        method: init.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.key ? { 'idempotency-key': init.key } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new RelayError('relay_transport_failed', true);
    }
    if (!response.ok) {
      // Cancel without reading: a provider body must not reach logs or errors.
      await response.body?.cancel().catch(() => undefined);
      const retryable =
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429;
      throw new RelayError(`relay_http_${response.status}`, retryable);
    }
    const text = await this.readBounded(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RelayError('relay_response_invalid', true);
    }
  }

  /** Stops reading as soon as the body passes the limit, so it is never fully buffered. */
  private async readBounded(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new RelayError('relay_response_too_large', true);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError('relay_transport_failed', true);
    }
    return Buffer.concat(chunks).toString();
  }

  private parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RelayError('relay_response_invalid', true);
    return parsed.data;
  }

  async identity(): Promise<RelayIdentity> {
    const { data } = this.parse(IDENTITY_SCHEMA, await this.request('/v1/agent'));
    return { agentId: data.id, workspaceId: data.workspace_id, address: data.address };
  }

  async conversations(): Promise<RelayConversation[]> {
    const { data } = this.parse(CONVERSATIONS_SCHEMA, await this.request('/v1/dm/conversations'));
    return data.map((c) => ({
      id: c.id,
      type: c.type,
      participants: c.participants.map((p) => p.agent_id),
      lastMessageId: c.last_message?.id,
    }));
  }

  async messages(
    conversationId: string,
    page: { after?: string; before?: string; limit: number }
  ): Promise<RelayMessage[]> {
    const query = new URLSearchParams({
      limit: String(page.limit),
      ...(page.after ? { after: page.after } : {}),
      ...(page.before ? { before: page.before } : {}),
    });
    const { data } = this.parse(
      MESSAGES_SCHEMA,
      await this.request(`/v1/dm/${encodeURIComponent(conversationId)}/messages?${query}`)
    );
    return data.map((m) => ({
      id: m.id,
      agentId: m.agent_id,
      agentName: m.agent_name,
      text: m.text,
      metadata: m.metadata,
      sentAt: m.created_at && !Number.isNaN(Date.parse(m.created_at)) ? Date.parse(m.created_at) : undefined,
    }));
  }

  async sendReport(report: SendReport): Promise<void> {
    await this.request('/v1/dm', {
      method: 'POST',
      key: report.idempotencyKey,
      body: { address: report.address, text: report.text, mode: 'wait', data: report.data },
    });
  }

  async invokeSpawn(request: SpawnRequest): Promise<SpawnReceipt> {
    const result = await this.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      key: request.idempotencyKey,
      body: {
        input: {
          name: request.name,
          cli: request.harness,
          task: request.task,
          target_node: request.targetNodeName,
          worker_cwd: request.directory,
          verify_ready: true,
        },
      },
    });
    return toReceipt(this.parse(RECEIPT_SCHEMA, result).data);
  }

  async invocation(id: string): Promise<SpawnReceipt> {
    const result = await this.request(`/v1/actions/spawn/invocations/${encodeURIComponent(id)}`);
    const receipt = toReceipt(this.parse(RECEIPT_SCHEMA, result).data);
    if (receipt.id !== id) throw new RelayError('relay_response_invalid', true);
    return receipt;
  }
}
