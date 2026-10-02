import http from 'node:http';

export class SocketResponseError extends Error {
  constructor(response) {
    const code = response?.error?.code || 'connect_request_failed';
    super(response?.error?.message || code);
    this.name = 'SocketResponseError';
    this.code = code;
    this.response = response;
  }
}

export function requestJson(
  socketPath,
  { method = 'GET', path, body, timeoutMs = 30_000, headers: extraHeaders = {} } = {}
) {
  return new Promise((resolve, reject) => {
    const headers = { accept: 'application/json', ...extraHeaders };
    if (body !== undefined) {
      headers['content-length'] = Buffer.byteLength(body);
    }

    const request = http.request({ socketPath, method, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = text.length > 0 ? JSON.parse(text) : {};
        } catch {
          reject(new Error('Agent Relay probe returned invalid JSON.'));
          return;
        }
        resolve(parsed);
      });
    });

    request.setTimeout(timeoutMs, () => {
      const error = new Error('Agent Relay probe request timed out.');
      error.code = 'SOCKET_TIMEOUT';
      request.destroy(error);
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export function requireOk(response) {
  if (!response || response.ok !== true) throw new SocketResponseError(response);
  return response;
}
