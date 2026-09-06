/**
 * A transparent tap in front of a REAL Relaycast engine.
 *
 * The broker derives both its HTTP base and its `/v1/node/ws` URL from one
 * `RELAY_BASE_URL`, so the only way to control the node-control wire without
 * also faking workspace bootstrap, node enrolment and agent registration is to
 * sit between the two and forward everything.
 *
 * Everything the broker and the engine say to each other passes through
 * untouched. The tap adds exactly two powers, and the case needs both:
 *
 *   - `sendToBroker(frame)` injects a `deliver` frame with a sequence number of
 *     the case's choosing. A real engine will not hand out a forward hole on
 *     demand, and a hole is the input under test.
 *   - `acks` records every `delivery.ack` the broker emits. That frame is the
 *     observable under test: on the base broker a gap produces one, on the head
 *     broker it does not.
 *
 * The tap never suppresses or rewrites a frame, so the broker's own view of the
 * engine is exactly what it would be without it.
 */
import { createServer } from 'node:http';

/**
 * @param {number} enginePort  the real engine
 * @param {{WebSocketServer: any, WebSocket: any}} ws  the `ws` module, loaded
 *   from the case's own install rather than imported by name: the proof sandbox
 *   has no node_modules at the repo root.
 * @param {(line: string) => void} log
 */
export async function startNodeControlTap(enginePort, ws, log = () => {}) {
  const { WebSocketServer, WebSocket } = ws;
  const engineOrigin = `http://127.0.0.1:${enginePort}`;
  const acks = [];
  /** name -> agent_id, learned by watching agent.register replies go past. */
  const agentIds = new Map();
  /** correlation id -> agent name, from the broker's own agent.register frames. */
  const pendingRegisters = new Map();
  let brokerSocket = null;

  const server = createServer(async (request, response) => {
    // Plain HTTP (workspace bootstrap, node mint, metadata publish) is proxied
    // verbatim; none of it is what this case observes.
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = { ...request.headers };
      delete headers.host;
      delete headers['content-length'];
      const upstream = await fetch(`${engineOrigin}${request.url}`, {
        method: request.method,
        headers,
        ...(body && body.length ? { body } : {}),
      });
      const payload = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = {};
      for (const [key, value] of upstream.headers) {
        if (key === 'content-encoding' || key === 'transfer-encoding' || key === 'content-length') {
          continue;
        }
        outHeaders[key] = value;
      }
      response.writeHead(upstream.status, outHeaders);
      response.end(payload);
    } catch (error) {
      log(`[tap] http ${request.method} ${request.url} failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"tap upstream failure"}');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const path = request.url ?? '/';
    wss.handleUpgrade(request, socket, head, (downstream) => {
      const headers = {};
      if (request.headers.authorization) headers.authorization = request.headers.authorization;
      const upstream = new WebSocket(`ws://127.0.0.1:${enginePort}${path}`, { headers });
      const isNodeControl = path.startsWith('/v1/node/ws');
      if (isNodeControl) brokerSocket = downstream;

      // Frames the broker produces before the engine leg finishes its own
      // handshake must not be dropped, or node.register races the connection.
      const queued = [];
      let upstreamOpen = false;
      upstream.on('open', () => {
        upstreamOpen = true;
        for (const frame of queued.splice(0)) upstream.send(frame);
      });

      downstream.on('message', (data) => {
        const text = data.toString();
        if (isNodeControl) {
          try {
            const frame = JSON.parse(text);
            if (frame?.type === 'agent.register' && frame.id && frame.name) {
              pendingRegisters.set(frame.id, frame.name);
            }
            if (frame?.type === 'delivery.ack') {
              acks.push({ agent: frame.agent, upToSeq: frame.up_to_seq, at: Date.now() });
              log(`[tap] broker -> delivery.ack agent=${frame.agent} up_to_seq=${frame.up_to_seq}`);
            }
          } catch {
            /* non-JSON control frames are forwarded untouched */
          }
        }
        if (upstreamOpen) upstream.send(text);
        else queued.push(text);
      });

      upstream.on('message', (data) => {
        const text = data.toString();
        if (isNodeControl) {
          try {
            const frame = JSON.parse(text);
            if (frame?.type === 'reply' && frame.ok && pendingRegisters.has(frame.id)) {
              const name = pendingRegisters.get(frame.id);
              pendingRegisters.delete(frame.id);
              const agentId = frame?.data?.agent_id;
              if (agentId) {
                agentIds.set(name, agentId);
                log(`[tap] engine -> agent.register reply ${name} = ${agentId}`);
              }
            }
          } catch {
            /* ignore */
          }
        }
        if (downstream.readyState === WebSocket.OPEN) downstream.send(text);
      });

      const close = () => {
        if (downstream.readyState === WebSocket.OPEN) downstream.close();
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
        if (isNodeControl && brokerSocket === downstream) brokerSocket = null;
      };
      downstream.on('close', close);
      upstream.on('close', close);
      downstream.on('error', (error) => log(`[tap] downstream error: ${error.message}`));
      upstream.on('error', (error) => log(`[tap] upstream error: ${error.message}`));
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  log(`[tap] listening on 127.0.0.1:${port} in front of ${engineOrigin}`);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    acks,
    agentIdFor: (name) => agentIds.get(name),
    sendToBroker(frame) {
      if (!brokerSocket || brokerSocket.readyState !== WebSocket.OPEN) {
        throw new Error('The broker is not connected to node control.');
      }
      brokerSocket.send(JSON.stringify(frame));
    },
    async stop() {
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
