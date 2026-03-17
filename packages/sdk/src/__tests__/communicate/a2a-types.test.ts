import { describe, it, expect } from 'vitest';

import {
  type A2AAgentCard,
  type A2AMessage,
  type A2APart,
  type A2ASkill,
  type A2ATask,
  type A2ATaskStatus,
  VALID_TASK_STATES,
  a2aAgentCardFromDict,
  a2aAgentCardToDict,
  a2aMessageFromDict,
  a2aMessageGetText,
  a2aMessageToDict,
  a2aPartFromDict,
  a2aPartToDict,
  a2aSkillFromDict,
  a2aSkillToDict,
  a2aTaskFromDict,
  a2aTaskStatusFromDict,
  a2aTaskStatusToDict,
  a2aTaskToDict,
  createA2AAgentCard,
  createA2AMessage,
  createA2APart,
  createA2ATask,
  createA2ATaskStatus,
  makeJsonRpcError,
  makeJsonRpcRequest,
  makeJsonRpcResponse,
  JSONRPC_PARSE_ERROR,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INTERNAL_ERROR,
  A2A_TASK_NOT_FOUND,
  A2A_TASK_NOT_CANCELABLE,
} from '../../communicate/a2a-types.js';

describe('A2APart', () => {
  it('creates a text part', () => {
    const part = createA2APart('hello');
    expect(part.text).toBe('hello');
  });

  it('serializes to dict with only defined fields', () => {
    const part: A2APart = { text: 'hello' };
    const d = a2aPartToDict(part);
    expect(d).toEqual({ text: 'hello' });
    expect(d).not.toHaveProperty('file');
    expect(d).not.toHaveProperty('data');
  });

  it('deserializes from dict', () => {
    const d = { text: 'world', file: { uri: 'test.txt' } };
    const part = a2aPartFromDict(d);
    expect(part.text).toBe('world');
    expect(part.file).toEqual({ uri: 'test.txt' });
    expect(part.data).toBeUndefined();
  });
});

describe('A2AMessage', () => {
  it('creates with auto-generated messageId', () => {
    const msg = createA2AMessage('user', [{ text: 'hi' }]);
    expect(msg.role).toBe('user');
    expect(msg.messageId).toBeDefined();
    expect(msg.messageId!.length).toBeGreaterThan(0);
    expect(msg.parts).toHaveLength(1);
  });

  it('creates with explicit messageId', () => {
    const msg = createA2AMessage('agent', [{ text: 'reply' }], {
      messageId: 'msg-123',
      contextId: 'ctx-1',
      taskId: 'task-1',
    });
    expect(msg.messageId).toBe('msg-123');
    expect(msg.contextId).toBe('ctx-1');
    expect(msg.taskId).toBe('task-1');
  });

  it('serializes and deserializes roundtrip', () => {
    const msg = createA2AMessage('user', [{ text: 'hello' }, { text: 'world' }], {
      messageId: 'test-id',
      contextId: 'ctx-1',
    });
    const dict = a2aMessageToDict(msg);
    const restored = a2aMessageFromDict(dict);
    expect(restored.role).toBe('user');
    expect(restored.parts).toHaveLength(2);
    expect(restored.messageId).toBe('test-id');
    expect(restored.contextId).toBe('ctx-1');
  });

  it('extracts concatenated text', () => {
    const msg: A2AMessage = {
      role: 'agent',
      parts: [{ text: 'hello' }, { text: 'world' }, { data: { key: 'val' } }],
    };
    expect(a2aMessageGetText(msg)).toBe('hello world');
  });

  it('extracts empty text from no text parts', () => {
    const msg: A2AMessage = { role: 'agent', parts: [{ data: { x: 1 } }] };
    expect(a2aMessageGetText(msg)).toBe('');
  });
});

describe('A2ATaskStatus', () => {
  it('creates with auto timestamp', () => {
    const status = createA2ATaskStatus('submitted');
    expect(status.state).toBe('submitted');
    expect(status.timestamp).toBeDefined();
  });

  it('serializes and deserializes roundtrip', () => {
    const msg = createA2AMessage('agent', [{ text: 'done' }], { messageId: 'r1' });
    const status = createA2ATaskStatus('completed', msg);
    const dict = a2aTaskStatusToDict(status);
    expect(dict.state).toBe('completed');
    expect(dict.message).toBeDefined();

    const restored = a2aTaskStatusFromDict(dict);
    expect(restored.state).toBe('completed');
    expect(restored.message?.role).toBe('agent');
  });

  it('deserializes without message', () => {
    const dict = { state: 'working', timestamp: '2024-01-01T00:00:00Z' };
    const status = a2aTaskStatusFromDict(dict);
    expect(status.state).toBe('working');
    expect(status.message).toBeUndefined();
  });
});

describe('VALID_TASK_STATES', () => {
  it('contains all expected states', () => {
    expect(VALID_TASK_STATES.has('submitted')).toBe(true);
    expect(VALID_TASK_STATES.has('working')).toBe(true);
    expect(VALID_TASK_STATES.has('completed')).toBe(true);
    expect(VALID_TASK_STATES.has('failed')).toBe(true);
    expect(VALID_TASK_STATES.has('canceled')).toBe(true);
    expect(VALID_TASK_STATES.has('unknown')).toBe(false);
  });
});

describe('A2ATask', () => {
  it('creates with defaults', () => {
    const task = createA2ATask('task-1', 'ctx-1');
    expect(task.id).toBe('task-1');
    expect(task.contextId).toBe('ctx-1');
    expect(task.status.state).toBe('submitted');
    expect(task.messages).toEqual([]);
    expect(task.artifacts).toEqual([]);
  });

  it('serializes and deserializes roundtrip', () => {
    const task: A2ATask = {
      id: 'task-42',
      contextId: 'ctx-7',
      status: createA2ATaskStatus('completed'),
      messages: [createA2AMessage('user', [{ text: 'do stuff' }], { messageId: 'm1' })],
      artifacts: [{ type: 'text', data: 'result' }],
    };

    const dict = a2aTaskToDict(task);
    expect(dict.id).toBe('task-42');

    const restored = a2aTaskFromDict(dict);
    expect(restored.id).toBe('task-42');
    expect(restored.contextId).toBe('ctx-7');
    expect(restored.status.state).toBe('completed');
    expect(restored.messages).toHaveLength(1);
    expect(restored.artifacts).toHaveLength(1);
  });

  it('deserializes with missing status defaults to submitted', () => {
    const dict = { id: 't1', messages: [], artifacts: [] };
    const task = a2aTaskFromDict(dict);
    expect(task.status.state).toBe('submitted');
  });
});

describe('A2ASkill', () => {
  it('serializes and deserializes', () => {
    const skill: A2ASkill = {
      id: 'billing',
      name: 'Billing',
      description: 'Handles billing queries',
    };
    const dict = a2aSkillToDict(skill);
    expect(dict).toEqual({
      id: 'billing',
      name: 'Billing',
      description: 'Handles billing queries',
    });

    const restored = a2aSkillFromDict(dict);
    expect(restored).toEqual(skill);
  });
});

describe('A2AAgentCard', () => {
  it('creates with defaults', () => {
    const card = createA2AAgentCard('test-agent', 'A test agent', 'http://localhost:5000');
    expect(card.name).toBe('test-agent');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
    expect(card.skills).toEqual([]);
  });

  it('creates with skills', () => {
    const skills: A2ASkill[] = [{ id: 's1', name: 'Search', description: 'Search things' }];
    const card = createA2AAgentCard('agent', 'desc', 'http://localhost:5000', skills);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe('s1');
  });

  it('serializes and deserializes roundtrip', () => {
    const card = createA2AAgentCard(
      'my-agent',
      'My agent',
      'http://example.com',
      [{ id: 'sk1', name: 'Skill1', description: 'Does skill1' }],
    );
    const dict = a2aAgentCardToDict(card);
    const restored = a2aAgentCardFromDict(dict);
    expect(restored.name).toBe('my-agent');
    expect(restored.description).toBe('My agent');
    expect(restored.url).toBe('http://example.com');
    expect(restored.version).toBe('1.0.0');
    expect(restored.skills).toHaveLength(1);
    expect(restored.skills[0].name).toBe('Skill1');
  });

  it('deserializes with defaults for missing fields', () => {
    const dict = { name: 'agent', description: 'desc', url: 'http://localhost' };
    const card = a2aAgentCardFromDict(dict);
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
    expect(card.skills).toEqual([]);
  });
});

describe('JSON-RPC helpers', () => {
  it('makeJsonRpcRequest creates valid request', () => {
    const req = makeJsonRpcRequest('message/send', { message: { role: 'user', parts: [] } }, 'req-1');
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('message/send');
    expect(req.id).toBe('req-1');
    expect(req.params).toHaveProperty('message');
  });

  it('makeJsonRpcRequest auto-generates id', () => {
    const req = makeJsonRpcRequest('test', {});
    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe('string');
  });

  it('makeJsonRpcResponse creates valid response', () => {
    const res = makeJsonRpcResponse({ ok: true }, 'req-1');
    expect(res.jsonrpc).toBe('2.0');
    expect(res.result).toEqual({ ok: true });
    expect(res.id).toBe('req-1');
    expect(res.error).toBeUndefined();
  });

  it('makeJsonRpcError creates valid error response', () => {
    const res = makeJsonRpcError(-32600, 'Invalid request', 'req-1');
    expect(res.jsonrpc).toBe('2.0');
    expect(res.error).toEqual({ code: -32600, message: 'Invalid request' });
    expect(res.id).toBe('req-1');
    expect(res.result).toBeUndefined();
  });

  it('makeJsonRpcError handles null id', () => {
    const res = makeJsonRpcError(-32700, 'Parse error', null);
    expect(res.id).toBeNull();
  });
});

describe('Error code constants', () => {
  it('has correct standard JSON-RPC codes', () => {
    expect(JSONRPC_PARSE_ERROR).toBe(-32700);
    expect(JSONRPC_METHOD_NOT_FOUND).toBe(-32601);
    expect(JSONRPC_INTERNAL_ERROR).toBe(-32603);
  });

  it('has correct A2A-specific codes', () => {
    expect(A2A_TASK_NOT_FOUND).toBe(-32001);
    expect(A2A_TASK_NOT_CANCELABLE).toBe(-32002);
  });
});
