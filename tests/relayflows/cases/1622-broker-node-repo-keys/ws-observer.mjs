// A dependency-free stand-in for Relaycast's node-control endpoint.
//
// The broker opens `ws://<base>/v1/node/ws` and sends `node.register` as its
// first text frame (see `node_control_client_round_trips_mock_engine_ws` in
// crates/broker/src/node_control.rs, which asserts exactly that ordering). That
// frame is the production wire surface this case observes: `repo_keys` is
// declared `skip_serializing_if = "Option::is_none"`, so the field is simply
// absent when the broker has nothing to advertise.
//
// Implemented against the raw socket rather than the `ws` package because the
// runner must work inside whichever checkout it is handed, and neither target
// checkout is guaranteed to have a WebSocket server dependency installed.

import crypto from 'node:crypto';
import http from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Decode one RFC 6455 client frame, or null when more bytes are needed. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > 8_388_608n) throw new Error(`refusing an implausible ${big}-byte frame`);
    length = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
  }
  return { opcode, payload, size: offset + length };
}

/**
 * Listen on an ephemeral port and resolve the first `node.register` payload.
 *
 * Plain HTTP requests get a permissive `{}` so an unrelated startup call cannot
 * abort the broker before it reaches the node-control socket. Nothing here
 * inspects or asserts; the caller owns the semantics.
 */
export function startNodeControlObserver() {
  let resolveRegister;
  const register = new Promise((resolve) => {
    resolveRegister = resolve;
  });
  const frames = [];

  // The broker completes an HTTP startup session before it opens the
  // node-control socket, so these have to answer in Relaycast's envelope shape
  // (`{ok, data}`) or the broker aborts with "failed registering agent for
  // configured workspace". The shapes mirror the mocks in
  // crates/broker/src/relaycast/auth.rs. Nothing here is asserted on; it exists
  // only to let the broker reach the frame this case actually reads.
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let name = 'relayflow-proof';
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof parsed.name === 'string' && parsed.name) name = parsed.name;
      } catch {
        // Not every startup call carries a JSON body; the default name is fine.
      }
      const agent = {
        id: 'a_relayflow_proof',
        workspace_id: 'ws_relayflow_proof',
        name,
        type: 'agent',
        token: 'at_live_relayflowproof',
        status: 'online',
        persona: null,
        metadata: {},
        channels: [],
        created_at: '2025-01-01T00:00:00Z',
        last_seen: '2025-01-01T00:00:00Z',
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: agent }));
    });
  });

  server.on('upgrade', (req, socket) => {
    if (!req.url || !req.url.startsWith('/v1/node/ws')) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );

    let buffered = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        let frame;
        try {
          frame = decodeFrame(buffered);
        } catch {
          socket.destroy();
          return;
        }
        if (!frame) return;
        buffered = buffered.subarray(frame.size);
        if (frame.opcode === 0x8) {
          socket.end();
          return;
        }
        if (frame.opcode !== 0x1) continue;
        const text = frame.payload.toString('utf8');
        frames.push(text);
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          continue;
        }
        if (message && message.type === 'node.register') resolveRegister(message);
      }
    });
  });

  const listening = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  return { server, listening, register, frames };
}
