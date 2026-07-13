import WebSocketImpl from 'ws';

/**
 * Node exposes a global `WebSocket` only from v22 (unflagged). Relay supports
 * Node >=20.9 (root `engines`), where `@relaycast/sdk`'s WebSocket transport
 * (`AgentClient`, `NodeProviderClient`) would otherwise throw
 * `WebSocket is not defined` at connect time. Install the bundled `ws`
 * implementation as the global when the runtime lacks its own; a no-op on
 * Node 22+ and in browsers.
 */
export function ensureWebSocketGlobal(): void {
  const target = globalThis as { WebSocket?: unknown };
  if (typeof target.WebSocket === 'undefined') {
    target.WebSocket = WebSocketImpl;
  }
}
