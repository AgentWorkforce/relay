import type {
  AgentPolicy,
  ApprovalVerdictRecord,
  PolicyActionType,
  PolicySuggestion,
  RelayfileClient,
} from './types.js';

interface PolicyGateOptions {
  workspace: string;
  agentId: string;
  policy?: AgentPolicy;
  relayfile: RelayfileClient;
  awaitApproval?: (approvalId: string) => Promise<unknown>;
}

export function createPolicyGate(options: PolicyGateOptions) {
  return {
    run: async <T>(
      actionType: PolicyActionType,
      action: Record<string, unknown>,
      execute: () => Promise<T>
    ): Promise<T | PolicySuggestion> => {
      if (!options.policy) {
        return await execute();
      }

      const mode = resolveActionMode(options.policy, actionType);
      const id = globalThis.crypto.randomUUID();
      const timestamp = new Date().toISOString();

      if (mode === 'suggest') {
        const suggestion = buildSuggestion(options, id, timestamp, actionType, action);
        await writeAuditLog(options, suggestion.id, {
          id: suggestion.id,
          decision: suggestion.decision,
          actionType,
          workspace: options.workspace,
          agentId: options.agentId,
          createdAt: timestamp,
          action,
        });
        return suggestion;
      }

      if (mode === 'approval-required') {
        if (typeof options.awaitApproval !== 'function') {
          throw new Error('policy approval flow is unavailable without a gateway approval coordinator');
        }

        await safeRelayfileWrite(options.relayfile, `/pending-approvals/${id}.json`, {
          id,
          workspace: options.workspace,
          agentId: options.agentId,
          actionType,
          createdAt: timestamp,
          action,
        });

        const verdict = normalizeApprovalVerdict(id, await options.awaitApproval(id));
        try {
          await writeAuditLog(options, id, {
            id,
            decision: verdict.verdict === 'approved' ? 'approved' : 'rejected',
            actionType,
            workspace: options.workspace,
            agentId: options.agentId,
            createdAt: timestamp,
            approval: verdict.raw,
            action,
          });
        } finally {
          await safeRelayfileDelete(options.relayfile, `/pending-approvals/${id}.json`);
        }

        if (verdict.verdict !== 'approved') {
          throw new Error(
            verdict.reason?.trim()
              ? `policy approval rejected: ${verdict.reason.trim()}`
              : `policy approval rejected for ${actionType}`
          );
        }

        return await execute();
      }

      await writeAuditLog(options, id, {
        id,
        decision: 'auto',
        actionType,
        workspace: options.workspace,
        agentId: options.agentId,
        createdAt: timestamp,
        action,
      });
      return await execute();
    },
  };
}

function resolveActionMode(
  policy: AgentPolicy | undefined,
  actionType: PolicyActionType
): AgentPolicy['mode'] {
  const mode = policy?.mode ?? 'auto';
  if (policy?.approvals?.includes(actionType)) {
    return 'approval-required';
  }

  return mode;
}

function buildSuggestion(
  options: PolicyGateOptions,
  id: string,
  createdAt: string,
  actionType: PolicyActionType,
  action: Record<string, unknown>
): PolicySuggestion {
  return {
    id,
    decision: 'suggested',
    actionType,
    workspace: options.workspace,
    agentId: options.agentId,
    createdAt,
    action,
  };
}

async function writeAuditLog(
  options: PolicyGateOptions,
  id: string,
  payload: Record<string, unknown>
): Promise<void> {
  await safeRelayfileWrite(options.relayfile, `/_policy-log/${options.workspace}/${id}.json`, payload);
}

async function safeRelayfileWrite(relayfile: RelayfileClient, path: string, body: unknown): Promise<void> {
  try {
    await relayfile.write(path, body);
  } catch (error) {
    if (isUnavailableRelayfileError(error)) {
      return;
    }
    throw error;
  }
}

async function safeRelayfileDelete(relayfile: RelayfileClient, path: string): Promise<void> {
  try {
    await relayfile.delete(path);
  } catch (error) {
    if (isUnavailableRelayfileError(error)) {
      return;
    }
    throw error;
  }
}

function isUnavailableRelayfileError(error: unknown): boolean {
  return error instanceof Error && error.message === 'relayfile control plane is not ready yet';
}

function normalizeApprovalVerdict(id: string, value: unknown): ApprovalVerdictRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`approval ${id} returned an invalid verdict payload`);
  }

  const record = value as Record<string, unknown>;
  const verdict = normalizeVerdict(record);
  if (!verdict) {
    throw new Error(`approval ${id} is missing a supported verdict`);
  }

  return {
    id,
    verdict,
    approvedBy: typeof record.approvedBy === 'string' ? record.approvedBy : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    raw: record,
  };
}

function normalizeVerdict(record: Record<string, unknown>): ApprovalVerdictRecord['verdict'] | null {
  if (typeof record.verdict === 'string') {
    const normalized = record.verdict.trim().toLowerCase();
    if (normalized === 'approved' || normalized === 'approve') {
      return 'approved';
    }
    if (
      normalized === 'rejected' ||
      normalized === 'reject' ||
      normalized === 'denied' ||
      normalized === 'deny'
    ) {
      return 'rejected';
    }
  }

  if (typeof record.approved === 'boolean') {
    return record.approved ? 'approved' : 'rejected';
  }

  return null;
}
