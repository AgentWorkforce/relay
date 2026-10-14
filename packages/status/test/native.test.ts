import { expect, it } from 'vitest';
import { inferNativeWorkStatus, type NativeEvidence } from '../src/native.js';
const identity = { organizationId: 'org', workspaceId: 'rw_real', source: 'codex', sessionId: 'sess_real' };
const fact: NativeEvidence = {
  id: 'fact',
  at: '2026-10-14T00:00:00Z',
  kind: 'assistant',
  type: null,
  taskStatus: null,
  toolName: null,
};
it.each([
  [null, 'idle', 'no_activity'],
  [{ ...fact, kind: 'task_complete' }, 'idle', 'turn_finished'],
  [{ ...fact, kind: 'task', taskStatus: 'completed' }, 'done', 'completed'],
  [{ ...fact, kind: 'tool_call', toolName: 'request_user_input' }, 'needs_attention', 'human_input'],
  [
    { ...fact, kind: 'tool_call', toolName: 'request_user_input', type: 'tool_result' },
    'working',
    'thinking',
  ],
  [{ ...fact, kind: 'tool_call' }, 'working', 'tool_running'],
  [{ ...fact, kind: 'turn_aborted' }, 'idle', 'paused'],
] as const)('interprets normalized facts without a History dependency: %j', (evidence, state, reason) => {
  expect(inferNativeWorkStatus(identity, evidence)).toMatchObject({ state, reason, basis: 'inferred' });
});
