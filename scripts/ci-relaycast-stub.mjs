#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_BODY_BYTES = 64 * 1024;
const WORKSPACE_ID = 'ws_ci_publish_verify';

function usage() {
  return 'Usage: node scripts/ci-relaycast-stub.mjs --url-file <path>';
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--url-file' || !argv[1]?.trim()) {
    throw new Error(usage());
  }
  return { urlFile: resolve(argv[1]) };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
  }
  return body ? JSON.parse(body) : {};
}

function hasWorkspaceAuthorization(request) {
  return /^Bearer rk_[A-Za-z0-9_-]+$/.test(request.headers.authorization ?? '');
}

async function start() {
  const { urlFile } = parseArgs(process.argv.slice(2));
  let registrationSequence = 0;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'relay-ci-handshake-stub' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/agents') {
        if (!hasWorkspaceAuthorization(request)) {
          sendJson(response, 401, {
            ok: false,
            error: { code: 'unauthorized', message: 'workspace authorization required' },
          });
          return;
        }

        const body = await readJson(request);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          sendJson(response, 400, {
            ok: false,
            error: { code: 'invalid_agent_name', message: 'agent name is required' },
          });
          return;
        }

        registrationSequence += 1;
        sendJson(response, 200, {
          ok: true,
          data: {
            id: `agent_ci_${registrationSequence}`,
            workspace_id: WORKSPACE_ID,
            name,
            token: `at_ci_publish_verify_${registrationSequence}`,
            status: 'online',
            created_at: new Date().toISOString(),
          },
        });
        return;
      }

      sendJson(response, 404, {
        ok: false,
        error: { code: 'not_found', message: `${request.method} ${url.pathname} is not stubbed` },
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: {
          code: 'bad_request',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  server.on('error', (error) => {
    console.error(`Relaycast CI handshake stub failed: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(0, '127.0.0.1', () => {
    void (async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Relaycast CI handshake stub did not receive a TCP address');
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      await mkdir(dirname(urlFile), { recursive: true });
      await writeFile(urlFile, `${baseUrl}\n`, { mode: 0o600 });
      console.log(`Relaycast CI handshake stub listening on ${baseUrl}`);
    })().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      server.close();
    });
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
