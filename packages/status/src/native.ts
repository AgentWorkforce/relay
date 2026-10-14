import { initialSessionWorkStatus, type SessionWorkStatus } from './work.js';
type Identity = SessionWorkStatus['identity'];
export type NativeEvidence = {
  id: string;
  at: string;
  kind: string;
  type: string | null;
  taskStatus: string | null;
  toolName: string | null;
};
/** Conservative baseline for historical rows with no explicit status producer. */
export function inferNativeWorkStatus(id: Identity, evidence: NativeEvidence | null): SessionWorkStatus {
  const status = initialSessionWorkStatus(id);
  if (!evidence) return status;
  status.observedAt = evidence.at;
  status.lastSeenAt = evidence.at;
  status.evidenceIds = [evidence.id];
  const task = evidence.taskStatus?.toLowerCase();
  if (
    evidence.kind === 'task' &&
    ['completed', 'complete', 'finished', 'done', 'succeeded'].includes(task ?? '')
  ) {
    status.state = 'done';
    status.reason = 'completed';
  } else if (evidence.kind === 'task_complete') {
    status.reason = 'turn_finished';
  } else if (
    evidence.kind === 'turn_aborted' ||
    ['idle', 'paused', 'waiting', 'blocked', 'cancelled', 'canceled', 'failed'].includes(task ?? '')
  ) {
    status.reason = 'paused';
  } else if (
    evidence.type !== 'tool_result' &&
    /(^|[.:/]|__)(request_user_input|askuserquestion)$/i.test(evidence.toolName ?? '')
  ) {
    status.state = 'needs_attention';
    status.reason = 'human_input';
  } else {
    status.state = 'working';
    status.reason =
      (evidence.kind === 'tool_call' || evidence.type === 'tool_use') && evidence.type !== 'tool_result'
        ? 'tool_running'
        : 'thinking';
  }
  return status;
}
