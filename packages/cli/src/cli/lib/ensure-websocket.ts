import WebSocketImpl from 'ws';

/**
 * Node exposes a global `WebSocket` from v22. Relay supports Node 22+, but
 * install the bundled `ws` implementation when a non-Node runtime lacks one;
 * this is a no-op on supported Node versions and in browsers.
 */
export function ensureWebSocketGlobal(): void {
  const target = globalThis as { WebSocket?: unknown };
  if (typeof target.WebSocket === 'undefined') {
    target.WebSocket = WebSocketImpl;
  }
}
