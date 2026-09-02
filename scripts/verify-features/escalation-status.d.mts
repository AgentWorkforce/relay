export type EscalationChannel = 'posthog' | 'github_issue' | 'draft_pr' | 'slack_primary' | 'slack_followup';

export type EscalationState = 'delivered' | 'failed' | 'disabled' | 'not_applicable' | 'pending';

export interface EscalationStatus {
  schemaVersion: number;
  channel: EscalationChannel;
  state: EscalationState;
  detail: string;
  url?: string;
}

export interface AlertEnvelope {
  schemaVersion: 'relay-alert-envelope/1';
  idempotencyKey: string;
  producer: 'relay-verify-features';
  runId: string;
  kind: 'primary' | 'followup';
  severity: 'critical';
  destination: { provider: 'slack'; channel: string };
  text: string;
  sourceDelivery: EscalationStatus;
  postbackRequired: boolean;
  receiptRequired: true;
}

export const STATUS_FILES: Readonly<Record<EscalationChannel, string>>;
export function redactAlertText(value: unknown): string;
export function statusPath(artifacts: string, channel: EscalationChannel): string;
export function writeEscalationStatus(
  artifacts: string,
  channel: EscalationChannel,
  state: EscalationState,
  detail: string,
  url?: string
): EscalationStatus;
export function writeAlertEnvelope(
  artifacts: string,
  input: {
    kind: 'primary' | 'followup';
    runId: string;
    channel: string;
    text: string;
    sourceStatusChannel: EscalationChannel;
  }
): AlertEnvelope;
export function resetEscalationArtifacts(artifacts: string): void;
export function readEscalationStatus(artifacts: string, channel: EscalationChannel): EscalationStatus;
export function renderInitialEscalationStatus(artifacts: string): string;
export function renderFinalEscalationStatus(artifacts: string): string;
export function escalationAuditFailures(artifacts: string, options?: { autofixEnabled?: boolean }): string[];
export function escalationChannelAuditFailure(
  artifacts: string,
  channel: EscalationChannel,
  options?: { required?: boolean }
): string | null;
