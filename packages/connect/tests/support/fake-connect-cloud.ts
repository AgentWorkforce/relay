import http from 'node:http';

export type Delivery = {
  id: string;
  message_id: string;
  status: string;
  reason: string;
  message: { agent_name: string; text: string };
};

type Call = { method: string; path: string; headers: http.IncomingHttpHeaders; body: any };

/** Cloud's public Connect routes plus the Relaycast routes a participant uses, on loopback http. */
export class FakeConnectCloud {
  server!: http.Server;
  base = '';
  calls: Call[] = [];
  deliveries: Delivery[] = [];
  roster: Array<{ name: string; status: string }> = [
    { name: 'host-agent', status: 'online' },
    { name: 'guest-one', status: 'online' },
  ];
  joinStatus = 200;
  joinError: { code: string; message: string } | null = null;
  availability: { status: number; code?: string } = { status: 200 };
  apiErrors = new Map<string, { status: number; code: string }>();
  expiresAt = '2099-01-01T00:00:00Z';

  async start() {
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => this.handle(request, response, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as { port: number };
    this.base = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  callsTo(method: string, path: string) {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  private send(response: http.ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse, text: string) {
    const path = request.url || '/';
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    this.calls.push({ method: request.method || 'GET', path, headers: request.headers, body });
    const forced = this.apiErrors.get(`${request.method} ${path.split('?')[0]}`);
    if (forced) {
      this.send(response, forced.status, { ok: false, error: { code: forced.code, message: forced.code } });
      return;
    }
    const join = /^\/cloud\/connect\/([^/]+)\/join$/.exec(path);
    if (join && request.method === 'POST') {
      if (this.joinError) {
        this.send(response, this.joinStatus, { ok: false, error: this.joinError });
        return;
      }
      const name = body?.agent_name || 'guest-one';
      this.send(response, 200, {
        ok: true,
        data: {
          connect_id: join[1],
          task: 'Review the patch',
          expires_at: this.expiresAt,
          host: { person: 'Host Person', agent_name: 'host-agent' },
          participant: {
            agent_name: name,
            agent_id: 'agent-guest',
            role: 'guest',
            token: 'participant-token',
            relay_base_url: this.base,
          },
          participants: [
            { agent_name: 'host-agent', role: 'host' },
            { agent_name: name, role: 'guest' },
          ],
        },
      });
      return;
    }
    if (/^\/cloud\/connect\/[^/]+\/leave$/.test(path)) {
      this.send(response, 200, { ok: true, data: { left: true } });
      return;
    }
    if (/^\/connect\/[^/]+$/.test(path)) {
      const { status, code } = this.availability;
      if (status === 200) this.send(response, 200, { ok: true, data: { active: true } });
      else this.send(response, status, { ok: false, error: { code: code || 'connect_ended', message: 'gone' } });
      return;
    }
    if (path === '/v1/deliveries?limit=50') {
      this.send(response, 200, { ok: true, data: this.deliveries });
      return;
    }
    const settle = /^\/v1\/deliveries\/([^/]+)\/(ack|fail)$/.exec(path);
    if (settle) {
      const id = decodeURIComponent(settle[1]);
      const delivery = this.deliveries.find((item) => item.id === id);
      if (delivery) delivery.status = settle[2] === 'ack' ? 'acked' : 'failed';
      this.send(response, 200, { ok: true, data: { id, status: delivery?.status } });
      return;
    }
    if (path === '/v1/dm') {
      this.send(response, 200, { ok: true, data: { conversation_id: 'c1', message: { id: `m-${this.calls.length}` } } });
      return;
    }
    if (path === '/v1/agents?status=all') {
      this.send(response, 200, { ok: true, data: this.roster });
      return;
    }
    if (path === '/v1/agents/heartbeat' || path === '/v1/agents/disconnect') {
      this.send(response, 200, { ok: true, data: {} });
      return;
    }
    this.send(response, 404, { ok: false, error: { code: 'not_found', message: path } });
  }
}

export function delivery(id: string, text: string, overrides: Partial<Delivery> = {}): Delivery {
  return {
    id,
    message_id: `msg-${id}`,
    status: 'queued',
    reason: 'dm',
    message: { agent_name: 'host-agent', text },
    ...overrides,
  };
}
