/**
 * Minimal stand-in for Relaycast: enough HTTP to let `agent-relay-broker init`
 * reach a running state, plus a node-control websocket that can deliver a
 * message and re-register an agent under a fresh immutable identity.
 *
 * Self-contained on purpose. The fleet e2e harness needs a sibling relaycast
 * checkout, which the PR-proof sandbox does not have.
 *
 * Control plane for the runner, over stdin (one JSON command per line):
 *   {"cmd":"rotate_agent_id","name":"..."}  next agent.register for that name
 *                                           resolves to a NEW agent_id
 *   {"cmd":"deliver","agent":"...","seq":N,"msgId":"...","body":"..."}
 *   {"cmd":"state"}                          dump observed frames
 * Events go to stdout as JSON lines.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (...a) => process.stderr.write(`[fake] ${a.join(' ')}\n`);

/** name -> current immutable agent id. */
const agentIds = new Map();
/** names whose next agent.register must mint a brand-new agent id. */
const rotateNext = new Set();
let idSeq = 0;

function currentAgentId(name) {
  if (!agentIds.has(name)) agentIds.set(name, `agent_${name}_${++idSeq}`);
  return agentIds.get(name);
}
function rotateAgentId(name) {
  const fresh = `agent_${name}_${++idSeq}`;
  agentIds.set(name, fresh);
  return fresh;
}

// ---------------------------------------------------------------- websocket
function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/** Pull as many complete frames as `buf` holds. Returns [frames, rest]. */
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 2) break;
    const first = buf[offset];
    const second = buf[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (buf.length - cursor < 2) break;
      len = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (buf.length - cursor < 8) break;
      len = Number(buf.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - cursor < 4) break;
      mask = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buf.length - cursor < len) break;
    const payload = Buffer.from(buf.subarray(cursor, cursor + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    offset = cursor + len;
  }
  return [frames, buf.subarray(offset)];
}

let nodeSocket = null;
const observed = [];

function sendNode(obj) {
  if (!nodeSocket || nodeSocket.destroyed) {
    log('no node socket; dropping', obj.type);
    return false;
  }
  nodeSocket.write(encodeFrame(JSON.stringify(obj)));
  return true;
}

function handleNodeFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  observed.push(frame);
  emit({ event: 'node_frame', type: frame.type, frame });

  if (frame.type === 'node.register') {
    sendNode({ type: 'reply', v: 1, id: frame.id ?? 'node-register', ok: true, data: {} });
    return;
  }
  if (frame.type === 'agent.register') {
    const name = frame.name;
    const agentId = rotateNext.delete(name) ? rotateAgentId(name) : currentAgentId(name);
    emit({ event: 'agent_register', name, agentId });
    sendNode({
      type: 'reply',
      v: 1,
      id: frame.id ?? 'agent-register',
      ok: true,
      data: { agent_id: agentId, token: `at_${name}`, name, delivery_ack_seq: 0 },
    });
    return;
  }
  if (frame.type === 'delivery.ack') {
    emit({ event: 'delivery_ack', agent: frame.agent, upToSeq: frame.up_to_seq });
    return;
  }
  if (frame.type === 'inventory.sync' || frame.type === 'node.heartbeat') {
    sendNode({ type: 'reply', v: 1, id: frame.id ?? 'ack', ok: true, data: {} });
  }
}

// ---------------------------------------------------------------- http
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {}
    log('HTTP', req.method, url);
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url === '/v1/workspaces') {
      return json({
        ok: true,
        data: { workspace_id: 'ws_proof', api_key: 'rk_live_proof', created_at: '2026-01-01T00:00:00Z' },
      });
    }
    if (url === '/v1/nodes') {
      // `CreateNodeResponse` flattens `NodeRosterEntry`, so every non-`default`
      // field of that struct has to be present or the broker fails to parse the
      // envelope and retries `/v1/nodes` forever with no visible cause.
      return json({
        ok: true,
        data: {
          id: parsed.node_id ?? 'node_proof',
          name: parsed.name ?? 'proof-node',
          kind: parsed.kind ?? 'ws',
          role: parsed.role ?? 'broker',
          capabilities: [],
          tags: [],
          version: parsed.version ?? 'relay-broker/0.0.0',
          status: 'online',
          live: true,
          handlers_live: true,
          load: 0,
          active_agents: 0,
          max_agents: 8,
          created_at: '2026-01-01T00:00:00Z',
          token: 'nt_proof_node_token',
        },
      });
    }
    if (url.startsWith('/v1/channels')) return json({ ok: true, data: [] });
    if (url.startsWith('/v1/agents')) {
      const name = parsed.name ?? url.split('/')[3] ?? 'probe';
      return json({
        ok: true,
        data: {
          id: currentAgentId(name),
          workspace_id: 'ws_proof',
          name,
          token: `at_${name}`,
          status: 'online',
          created_at: '2026-01-01T00:00:00Z',
        },
      });
    }
    return json({ ok: true, data: {} });
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const isNodeControl = req.url.startsWith('/v1/node/ws');
  log('WS UPGRADE', req.url, isNodeControl ? '(node-control)' : '');
  if (isNodeControl) {
    nodeSocket = socket;
    emit({ event: 'node_control_connected' });
  }
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const [frames, rest] = decodeFrames(buffered);
    buffered = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(frame.payload.toString('utf8'), 0xa));
        continue;
      }
      if (frame.opcode === 0x1 && isNodeControl) handleNodeFrame(frame.payload.toString('utf8'));
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (nodeSocket === socket) nodeSocket = null;
  });
});

// ---------------------------------------------------------------- control
let stdinBuf = '';
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.cmd === 'rotate_agent_id') {
      rotateNext.add(cmd.name);
      emit({ event: 'rotate_armed', name: cmd.name });
    } else if (cmd.cmd === 'deliver') {
      const ok = sendNode({
        type: 'deliver',
        v: 1,
        agent: cmd.agent,
        agent_id: currentAgentId(cmd.agent),
        delivery_id: `del_${cmd.msgId}`,
        msg_id: cmd.msgId,
        seq: cmd.seq,
        mode: 'wait',
        payload: { type: 'message.created', text: cmd.body, from: 'proof-sender', target: cmd.agent },
      });
      emit({ event: 'delivered', ok, msgId: cmd.msgId, agentId: currentAgentId(cmd.agent) });
    } else if (cmd.cmd === 'state') {
      emit({ event: 'state', observed, agentIds: Object.fromEntries(agentIds) });
    }
  }
});

server.listen(0, '127.0.0.1', () => {
  emit({ event: 'listening', port: server.address().port });
});
process.once('SIGTERM', () => server.close(() => process.exit(0)));
