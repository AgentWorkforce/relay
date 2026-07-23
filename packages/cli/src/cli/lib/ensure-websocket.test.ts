import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocketImpl from 'ws';

import { ensureWebSocketGlobal } from './ensure-websocket.js';

const target = globalThis as { WebSocket?: unknown };

describe('ensureWebSocketGlobal', () => {
  let original: unknown;

  beforeEach(() => {
    original = target.WebSocket;
  });

  afterEach(() => {
    if (original === undefined) {
      delete target.WebSocket;
    } else {
      target.WebSocket = original;
    }
  });

  it('installs the ws implementation when no global WebSocket exists', () => {
    delete target.WebSocket;
    ensureWebSocketGlobal();
    expect(target.WebSocket).toBe(WebSocketImpl);
  });

  it('leaves an existing global WebSocket untouched', () => {
    const existing = function ExistingWebSocket() {};
    target.WebSocket = existing;
    ensureWebSocketGlobal();
    expect(target.WebSocket).toBe(existing);
  });
});
