import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';

/** Minimal loopback engine wire peer; no external credentials or package install. */
export async function engineFixture() {
  const frames = [];
  const sockets = new Set();
  let node;
  let failure;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (request.method === 'POST' && request.url === '/v1/agents') {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ok: true,
            data: {
              id: 'fixture-agent',
              name: body.name,
              workspace_id: 'fixture-workspace',
              token: 'at_fixture_task_proof',
              status: 'online',
              created_at: '2026-01-01T00:00:00Z',
            },
          })
        );
      } else {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ ok: false, error: { code: 'not_found', message: 'fixture route absent' } })
        );
      }
    } catch (error) {
      failure = error;
      response.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://fixture.invalid').pathname !== '/v1/node/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    try {
      assert.equal(request.headers.authorization, 'Bearer nt_fixture_task_proof');
      const accept = createHash('sha1')
        .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      node = socket;
      let buffer = head;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          while (buffer.length >= 2) {
            const frame = readClientFrame(buffer);
            if (!frame) return;
            buffer = frame.rest;
            const { opcode, data } = frame;
            if (opcode === 1) frames.push(JSON.parse(data.toString()));
            else if (opcode === 9) writeFrame(socket, data, 10);
            else if (opcode === 8) socket.end();
            else assert.equal(opcode, 10, 'Unexpected websocket opcode');
          }
        } catch (error) {
          failure = error;
          socket.destroy();
        }
      });
    } catch (error) {
      failure = error;
      socket.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    frames,
    check() {
      if (failure) throw failure;
    },
    send(value) {
      assert(node && !node.destroyed, 'Node wire must be connected');
      writeFrame(node, Buffer.from(JSON.stringify(value)));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function readClientFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 15;
  assert(buffer[0] & 128, 'Fixture expects unfragmented broker frames');
  assert(buffer[1] & 128, 'Client websocket frame must be masked');
  const indicator = buffer[1] & 127;
  assert(indicator !== 127, 'Unexpected oversized broker frame');
  let length = indicator;
  let offset = 2;
  if (indicator === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (buffer.length < offset + 4 + length) return undefined;
  const mask = buffer.subarray(offset, offset + 4);
  const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
  for (let i = 0; i < length; i++) data[i] ^= mask[i % 4];
  return { opcode, data, rest: buffer.subarray(offset + 4 + length) };
}

function writeFrame(socket, payload, opcode = 1) {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 128 | opcode;
  header[1] = payload.length < 126 ? payload.length : 126;
  if (header.length === 4) header.writeUInt16BE(payload.length, 2);
  socket.write(Buffer.concat([header, payload]));
}
