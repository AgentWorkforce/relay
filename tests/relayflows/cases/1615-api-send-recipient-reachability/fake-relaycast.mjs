import { createHash } from 'node:crypto';
import http from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export async function startFakeRelaycast({
  recipientName,
  offlineRecipientName,
  unknownRecipientName,
  failedRecipientName,
  agentReadDelayMs = 0,
  firstRecipientAgentReadDelayMs = agentReadDelayMs,
  failedAgentReadDelayMs = 0,
}) {
  const sockets = new Set();
  const state = {
    agentId: `agent_${recipientName.replaceAll('-', '_')}`,
    brokerRegistrations: 0,
    directMessages: [],
    channelMessages: [],
    agentReads: [],
    nodeFrames: [],
    nodeSocket: undefined,
  };

  const server = http.createServer(async (request, response) => {
    let body;
    try {
      body = await readJson(request);
    } catch {
      sendJson(response, 400, {
        ok: false,
        error: { code: 'invalid_json', message: 'Request body must be valid JSON.' },
      });
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://relayflow.invalid').pathname;

    if (request.method === 'POST' && pathname === '/v1/agents') {
      state.brokerRegistrations += 1;
      sendJson(response, 200, {
        ok: true,
        data: {
          id: 'agent_relayflow_broker',
          workspace_id: 'ws_relayflow_1615',
          name: body?.name ?? 'relayflow-1615-broker',
          token: 'at_relayflow_broker',
          status: 'active',
          created_at: '2026-09-02T00:00:00.000Z',
        },
      });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/agents/')) {
      const name = decodeURIComponent(pathname.slice('/v1/agents/'.length));
      const isFirstRecipientRead = name === recipientName && !state.agentReads.includes(recipientName);
      state.agentReads.push(name);
      const readDelayMs =
        name === failedRecipientName
          ? failedAgentReadDelayMs
          : isFirstRecipientRead
            ? firstRecipientAgentReadDelayMs
            : agentReadDelayMs;
      if (readDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      }
      if (name === unknownRecipientName) {
        sendJson(response, 503, {
          ok: false,
          error: { code: 'unavailable', message: 'deterministic reachability outage' },
        });
        return;
      }
      if (name !== recipientName && name !== offlineRecipientName && name !== failedRecipientName) {
        sendJson(response, 404, {
          ok: false,
          error: { code: 'agent_not_found', message: `Agent "${name}" not found` },
        });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        data: {
          id: name === recipientName ? state.agentId : `agent_${offlineRecipientName.replaceAll('-', '_')}`,
          workspace_id: 'ws_relayflow_1615',
          name,
          type: 'agent',
          status: name === offlineRecipientName ? 'offline' : 'active',
          persona: null,
          metadata: {},
          channels: [],
        },
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/channels/general/messages') {
      state.channelMessages.push(body);
      sendJson(response, 200, {
        ok: true,
        data: {
          id: `msg_channel_${state.channelMessages.length}`,
          agent_name: 'relayflow-1615-broker',
          agent_id: 'agent_relayflow_broker',
          text: body?.text ?? '',
          blocks: null,
          metadata: {},
          attachments: [],
          created_at: '2026-09-02T00:00:00.000Z',
          reply_count: 0,
          reactions: [],
          read_by_count: 0,
          injection_mode: body?.mode ?? 'wait',
        },
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/dm') {
      if (body?.to === failedRecipientName) {
        sendJson(response, 503, {
          ok: false,
          error: { code: 'unavailable', message: 'deterministic publish failure' },
        });
        return;
      }
      state.directMessages.push(body);
      const messageId = `msg_relayflow_${state.directMessages.length}`;
      sendJson(response, 200, {
        ok: true,
        data: {
          conversation_id: 'dm_relayflow_1615',
          message: {
            id: messageId,
            agent_id: 'agent_relayflow_broker',
            agent_name: 'relayflow-1615-broker',
            text: body?.text ?? '',
            injection_mode: body?.mode ?? 'wait',
          },
          created_at: '2026-09-02T00:00:00.000Z',
        },
      });
      if (body?.to === recipientName || body?.to === '@self') {
        setTimeout(() => {
          sendText(state.nodeSocket, {
            type: 'deliver',
            v: 1,
            agent: recipientName,
            agent_id: state.agentId,
            delivery_id: `delivery_${messageId}`,
            msg_id: messageId,
            seq: state.directMessages.length,
            mode: body?.mode ?? 'wait',
            payload: {
              type: 'dm.received',
              data: {
                text: body?.text ?? '',
                agent_name: 'relayflow-1615-broker',
              },
            },
          });
        }, 25);
      }
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/agents/release') {
      sendJson(response, 200, {
        ok: true,
        data: {
          invocation_id: 'invocation_release_relayflow_1615',
          action_name: 'release',
          handler_agent_id: null,
          handler_node_id: null,
          dispatched_node_id: null,
          input: { name: body?.name ?? recipientName },
          status: 'completed',
          created_at: '2026-09-02T00:00:00.000Z',
        },
      });
      return;
    }

    // Metadata publication, channel setup, release, and graceful-shutdown
    // bookkeeping are outside this case's routing contract. A successful
    // generic envelope keeps those best-effort paths from obscuring the probe.
    sendJson(response, 200, { ok: true, data: {} });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const pathname = new URL(request.url ?? '/', 'http://relayflow.invalid').pathname;
    if (pathname === '/v1/node/ws') state.nodeSocket = socket;
    attachFrameReader(
      socket,
      (frame) => {
        if (frame.opcode === 0x9) {
          sendFrame(socket, 0xa, frame.payload);
          return;
        }
        if (frame.opcode !== 0x1) return;
        const message = JSON.parse(frame.payload.toString('utf8'));
        state.nodeFrames.push(message);
        if (message.type === 'agent.register') {
          sendText(socket, {
            type: 'reply',
            v: 1,
            id: message.id,
            ok: true,
            data: {
              agent_id: state.agentId,
              token: 'at_relayflow_recipient',
              name: message.name,
              delivery_ack_seq: 0,
            },
          });
        }
      },
      head
    );
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected Relaycast TCP address.');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function attachFrameReader(socket, onFrame, initialData = Buffer.alloc(0)) {
  let buffered = Buffer.from(initialData);
  const consume = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const decoded = decodeFrame(buffered);
      if (!decoded) return;
      buffered = buffered.subarray(decoded.consumed);
      onFrame(decoded);
    }
  };
  socket.on('data', consume);
  if (buffered.length > 0) consume(Buffer.alloc(0));
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const wideLength = buffer.readBigUInt64BE(2);
    if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame is too large.');
    length = Number(wideLength);
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, consumed: offset + length };
}

function sendText(socket, value) {
  if (!socket || socket.destroyed) return false;
  sendFrame(socket, 0x1, Buffer.from(JSON.stringify(value)));
  return true;
}

function sendFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}
