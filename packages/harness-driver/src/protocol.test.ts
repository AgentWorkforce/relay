import { describe, expect, it } from 'vitest';

import type { BrokerToSdk, ProtocolEnvelope, SdkToBroker } from './protocol.js';

describe('fleet local protocol messages', () => {
  it('serializes fleet node registration frames', () => {
    const message: SdkToBroker = {
      type: 'register_node',
      payload: {
        manifest: {
          name: 'builder-1',
          node_id: 'node_local_1',
          capabilities: [
            { name: 'spawn:claude', kind: 'spawn', metadata: { provider: 'claude' } },
            { name: 'run-foo', metadata: { schema: 'v1' } },
          ],
          max_agents: 8,
          tags: ['local', 'gpu'],
          version: '0.1.0',
        },
      },
    };

    expect(JSON.parse(JSON.stringify(message))).toEqual({
      type: 'register_node',
      payload: {
        manifest: {
          name: 'builder-1',
          node_id: 'node_local_1',
          capabilities: [
            { name: 'spawn:claude', kind: 'spawn', metadata: { provider: 'claude' } },
            { name: 'run-foo', metadata: { schema: 'v1' } },
          ],
          max_agents: 8,
          tags: ['local', 'gpu'],
          version: '0.1.0',
        },
      },
    });
  });

  it('serializes handler registration and result frames', () => {
    const registerHandlers: SdkToBroker = {
      type: 'register_handlers',
      payload: { names: ['spawn:claude', 'run-foo'] },
    };
    const handlerResult: SdkToBroker = {
      type: 'handler_result',
      payload: { invocationId: 'inv_123', output: { ok: true } },
    };
    const handlerError: SdkToBroker = {
      type: 'handler_result',
      payload: { invocationId: 'inv_124', error: { code: 'handler_failed' } },
    };

    expect(JSON.parse(JSON.stringify(registerHandlers))).toEqual({
      type: 'register_handlers',
      payload: { names: ['spawn:claude', 'run-foo'] },
    });
    expect(JSON.parse(JSON.stringify(handlerResult))).toEqual({
      type: 'handler_result',
      payload: { invocationId: 'inv_123', output: { ok: true } },
    });
    expect(JSON.parse(JSON.stringify(handlerError))).toEqual({
      type: 'handler_result',
      payload: { invocationId: 'inv_124', error: { code: 'handler_failed' } },
    });
  });

  it('serializes broker handler invocation frames', () => {
    const message: BrokerToSdk = {
      type: 'invoke_handler',
      payload: {
        invocationId: 'inv_123',
        name: 'run-foo',
        input: { branch: 'main' },
      },
    };

    expect(JSON.parse(JSON.stringify(message))).toEqual({
      type: 'invoke_handler',
      payload: {
        invocationId: 'inv_123',
        name: 'run-foo',
        input: { branch: 'main' },
      },
    });
  });

  it('wraps fleet frames in the shared protocol envelope', () => {
    const frame: ProtocolEnvelope<SdkToBroker['payload']> = {
      v: 2,
      type: 'register_handlers',
      request_id: 'req_123',
      payload: { names: ['run-foo'] },
    };

    expect(JSON.parse(JSON.stringify(frame))).toEqual({
      v: 2,
      type: 'register_handlers',
      request_id: 'req_123',
      payload: { names: ['run-foo'] },
    });
  });
});
