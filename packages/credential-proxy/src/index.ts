import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import {
  app,
  createCredentialProxyApp,
  type CredentialProxyApp,
  type CredentialProxyOptions,
} from './router.js';

export { app, createCredentialProxyApp } from './router.js';
export { MeteringCollector, checkBudget, DEFAULT_BUDGET_RESERVATION } from './metering.js';
export { mintProxyToken, verifyProxyToken } from './jwt.js';
export * from './providers/index.js';
export type * from './providers/types.js';
export type {
  AdminTokenClaims,
  MeteringRecord,
  ProviderType,
  ProxyRequest,
  ProxyResponse,
  ProxyTokenClaims,
  UsageSummary,
} from './types.js';
export type { CredentialProxyOptions, CredentialProxyVariables, CredentialStore } from './router.js';

export interface StandaloneServeOptions extends CredentialProxyOptions {
  app?: CredentialProxyApp;
  hostname?: string;
  port?: number;
}

export type CredentialProxyServer = ReturnType<typeof createServer>;

export async function serve(options: StandaloneServeOptions = {}): Promise<CredentialProxyServer> {
  const proxyApp = options.app ?? createCredentialProxyApp(options);
  const port = options.port ?? Number.parseInt(process.env.PORT ?? '3001', 10);
  const hostname = options.hostname ?? process.env.HOST ?? '0.0.0.0';

  const server = createServer(async (req, res) => {
    try {
      const request = createWebRequest(req);
      const response = await proxyApp.fetch(request);
      await writeWebResponse(res, response);
    } catch (error) {
      console.error('[credential-proxy] standalone server error', error);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal server error', code: 'internal_error' }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`credential-proxy listening on http://${hostname}:${port}`);
  return server;
}

function createWebRequest(req: IncomingMessage): Request {
  const protocol = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http';
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `${protocol}://${host}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    if (typeof value === 'string') {
      headers.set(key, value);
    }
  }

  const method = req.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream<Uint8Array>);

  return new Request(url, {
    method,
    headers,
    body,
    duplex: body ? 'half' : undefined,
  });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const readable = Readable.fromWeb(response.body as ReadableStream);

  readable.on('error', (error) => {
    console.error('[credential-proxy] response streaming error', error);
    res.destroy(error);
  });

  for await (const chunk of readable) {
    if (!res.write(chunk)) {
      await once(res, 'drain');
    }
  }

  res.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void serve();
}
