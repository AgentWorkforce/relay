/**
 * DecisionQueue Component
 *
 * Displays pending decisions from agents that require human input,
 * with approve/reject actions and priority indicators.
 */

import React, { useState, useMemo } from 'react';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface Decision {
  id: string;
  agentName: string;
  timestamp: string | number;
  type: 'approval' | 'choice' | 'confirmation' | 'input';
  title: string;
  description: string;
  options?: { id: string; label: string; description?: string }[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  context?: Record<string, unknown>;
  expiresAt?: string | number;
}

export interface DecisionQueueProps {
  decisions: Decision[];
  onApprove?: (decisionId: string, optionId?: string) => Promise<void>;
  onReject?: (decisionId: string, reason?: string) => Promise<void>;
  onDismiss?: (decisionId: string) => void;
  isProcessing?: Record<string, boolean>;
}

export function DecisionQueue({
  decisions,
  onApprove,
  onReject,
  onDismiss,
  isProcessing = {},
}: DecisionQueueProps) {
  const [expandedDecision, setExpandedDecision] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, string>>({});

  // Sort by priority and timestamp
  const sortedDecisions = useMemo(() => {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...decisions].sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  }, [decisions]);

  // Count by priority
  const priorityCounts = useMemo(() => {
    return decisions.reduce(
      (acc, d) => {
        acc[d.priority] = (acc[d.priority] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
  }, [decisions]);

  const handleApprove = async (decision: Decision, optionId?: string) => {
    await onApprove?.(decision.id, optionId);
  };

  const handleReject = async (decision: Decision) => {
    await onReject?.(decision.id, rejectReason[decision.id]);
    setRejectReason((prev) => {
      const next = { ...prev };
      delete next[decision.id];
      return next;
    });
  };

  if (decisions.length === 0) {
    return (
      <div className="decision-queue decision-queue-empty">
        <CheckIcon />
        <span>No pending decisions</span>
      </div>
    );
  }

  return (
    <div className="decision-queue">
      <div className="decision-queue-header">
        <div className="decision-queue-title">
          <AlertIcon />
          <span>Pending Decisions</span>
          <span className="decision-queue-count">{decisions.length}</span>
        </div>
        <div className="decision-queue-summary">
          {priorityCounts.critical && (
            <span className="decision-priority-badge critical">{priorityCounts.critical} critical</span>
          )}
          {priorityCounts.high && (
            <span className="decision-priority-badge high">{priorityCounts.high} high</span>
          )}
        </div>
      </div>

      <div className="decision-queue-list">
        {sortedDecisions.map((decision) => (
          <DecisionCard
            key={decision.id}
            decision={decision}
            isExpanded={expandedDecision === decision.id}
            isProcessing={isProcessing[decision.id] || false}
            rejectReason={rejectReason[decision.id] || ''}
            onToggle={() =>
              setExpandedDecision((prev) => (prev === decision.id ? null : decision.id))
            }
            onApprove={(optionId) => handleApprove(decision, optionId)}
            onReject={() => handleReject(decision)}
            onRejectReasonChange={(reason) =>
              setRejectReason((prev) => ({ ...prev, [decision.id]: reason }))
            }
            onDismiss={() => onDismiss?.(decision.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface DecisionCardProps {
  decision: Decision;
  isExpanded: boolean;
  isProcessing: boolean;
  rejectReason: string;
  onToggle: () => void;
  onApprove: (optionId?: string) => void;
  onReject: () => void;
  onRejectReasonChange: (reason: string) => void;
  onDismiss: () => void;
}

function DecisionCard({
  decision,
  isExpanded,
  isProcessing,
  rejectReason,
  onToggle,
  onApprove,
  onReject,
  onRejectReasonChange,
  onDismiss,
}: DecisionCardProps) {
  const colors = getAgentColor(decision.agentName);
  const timestamp = formatTimestamp(decision.timestamp);
  const timeRemaining = decision.expiresAt ? getTimeRemaining(decision.expiresAt) : null;

  return (
    <div className={`decision-card ${decision.priority}`}>
      <div className="decision-card-header" onClick={onToggle}>
        <div
          className="decision-card-avatar"
          style={{ backgroundColor: colors.primary, color: colors.text }}
        >
          {getAgentInitials(decision.agentName)}
        </div>

        <div className="decision-card-info">
          <div className="decision-card-title">
            <span className="decision-card-agent">{decision.agentName}</span>
            <span className="decision-card-type">{formatType(decision.type)}</span>
            <PriorityBadge priority={decision.priority} />
          </div>
          <div className="decision-card-subtitle">{decision.title}</div>
        </div>

        <div className="decision-card-meta">
          {timeRemaining && (
            <span className={`decision-card-expires ${timeRemaining.urgent ? 'urgent' : ''}`}>
              {timeRemaining.text}
            </span>
          )}
          <span className="decision-card-time">{timestamp}</span>
          <ChevronIcon isExpanded={isExpanded} />
        </div>
      </div>

      {isExpanded && (
        <div className="decision-card-body">
          <p className="decision-card-desc">{decision.description}</p>

          {decision.context && Object.keys(decision.context).length > 0 && (
            <div className="decision-card-context">
              <span className="decision-card-context-label">Context</span>
              <pre>{JSON.stringify(decision.context, null, 2)}</pre>
            </div>
          )}

          {decision.type === 'choice' && decision.options && (
            <div className="decision-card-options">
              {decision.options.map((option) => (
                <button
                  key={option.id}
                  className="decision-card-option"
                  onClick={() => onApprove(option.id)}
                  disabled={isProcessing}
                >
                  <span className="decision-option-label">{option.label}</span>
                  {option.description && (
                    <span className="decision-option-desc">{option.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {decision.type !== 'choice' && (
            <div className="decision-card-actions">
              <button
                className="decision-btn decision-btn-approve"
                onClick={() => onApprove()}
                disabled={isProcessing}
              >
                {isProcessing ? <Spinner /> : <CheckIcon />}
                {decision.type === 'confirmation' ? 'Confirm' : 'Approve'}
              </button>

              <div className="decision-reject-group">
                <input
                  type="text"
                  className="decision-reject-input"
                  placeholder="Reason (optional)"
                  value={rejectReason}
                  onChange={(e) => onRejectReasonChange(e.target.value)}
                  disabled={isProcessing}
                />
                <button
                  className="decision-btn decision-btn-reject"
                  onClick={onReject}
                  disabled={isProcessing}
                >
                  <XIcon />
                  Reject
                </button>
              </div>
            </div>
          )}

          <button
            className="decision-card-dismiss"
            onClick={onDismiss}
            disabled={isProcessing}
          >
            Dismiss without action
          </button>
        </div>
      )}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: Decision['priority'] }) {
  return <span className={`decision-priority-badge ${priority}`}>{priority}</span>;
}

// Helper functions
function formatTimestamp(ts: string | number): string {
  const date = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return date.toLocaleDateString();
}

function formatType(type: Decision['type']): string {
  const labels: Record<Decision['type'], string> = {
    approval: 'Approval',
    choice: 'Choice',
    confirmation: 'Confirm',
    input: 'Input',
  };
  return labels[type];
}

function getTimeRemaining(expiresAt: string | number): { text: string; urgent: boolean } | null {
  const expiry = new Date(expiresAt);
  const now = new Date();
  const diffMs = expiry.getTime() - now.getTime();

  if (diffMs <= 0) return { text: 'Expired', urgent: true };

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 5) return { text: `${diffMins}m left`, urgent: true };
  if (diffMins < 60) return { text: `${diffMins}m left`, urgent: false };
  return { text: `${Math.floor(diffMins / 60)}h left`, urgent: false };
}

// Icon components
function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{
        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="decision-spinner" width="14" height="14" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * CSS styles for the decision queue
 */
export const decisionQueueStyles = `
.decision-queue {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
  overflow: hidden;
}

.decision-queue-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: #10b981;
  font-size: 13px;
}

.decision-queue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
}

.decision-queue-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.decision-queue-title svg {
  color: #f59e0b;
}

.decision-queue-count {
  font-weight: 600;
  font-size: 12px;
  color: #ffffff;
  background: #f59e0b;
  padding: 2px 8px;
  border-radius: 10px;
}

.decision-queue-summary {
  display: flex;
  gap: 8px;
}

.decision-queue-list {
  max-height: 500px;
  overflow-y: auto;
}

.decision-card {
  border-bottom: 1px solid #e8e8e8;
}

.decision-card:last-child {
  border-bottom: none;
}

.decision-card.critical {
  background: linear-gradient(to right, #fef2f2 0%, #ffffff 20%);
}

.decision-card.high {
  background: linear-gradient(to right, #fffbeb 0%, #ffffff 20%);
}

.decision-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.15s;
}

.decision-card-header:hover {
  background: rgba(0, 0, 0, 0.02);
}

.decision-card-avatar {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.decision-card-info {
  flex: 1;
  min-width: 0;
}

.decision-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.decision-card-agent {
  font-weight: 600;
  font-size: 13px;
  color: #333;
}

.decision-card-type {
  font-size: 11px;
  color: #888;
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
}

.decision-card-subtitle {
  font-size: 13px;
  color: #555;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.decision-card-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.decision-card-expires {
  font-size: 11px;
  color: #888;
}

.decision-card-expires.urgent {
  color: #ef4444;
  font-weight: 500;
}

.decision-card-time {
  font-size: 11px;
  color: #888;
}

.decision-card-body {
  padding: 0 16px 16px 64px;
}

.decision-card-desc {
  margin: 0 0 16px;
  font-size: 13px;
  color: #555;
  line-height: 1.5;
}

.decision-card-context {
  background: #f5f5f5;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
}

.decision-card-context-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.decision-card-context pre {
  margin: 0;
  font-size: 12px;
  font-family: 'SF Mono', monospace;
  color: #333;
  white-space: pre-wrap;
  word-break: break-word;
}

.decision-card-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.decision-card-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 12px 16px;
  background: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: all 0.15s;
}

.decision-card-option:hover:not(:disabled) {
  background: #f0f0f0;
  border-color: #d0d0d0;
}

.decision-card-option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.decision-option-label {
  font-size: 13px;
  font-weight: 500;
  color: #333;
}

.decision-option-desc {
  font-size: 12px;
  color: #888;
  margin-top: 2px;
}

.decision-card-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.decision-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.decision-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.decision-btn-approve {
  background: #10b981;
  color: #ffffff;
}

.decision-btn-approve:hover:not(:disabled) {
  background: #059669;
}

.decision-reject-group {
  display: flex;
  gap: 8px;
}

.decision-reject-input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  outline: none;
}

.decision-reject-input:focus {
  border-color: #1264a3;
}

.decision-btn-reject {
  background: #ffffff;
  color: #ef4444;
  border: 1px solid #fecaca;
}

.decision-btn-reject:hover:not(:disabled) {
  background: #fef2f2;
  border-color: #ef4444;
}

.decision-card-dismiss {
  margin-top: 12px;
  padding: 8px;
  background: transparent;
  border: none;
  color: #888;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: color 0.15s;
}

.decision-card-dismiss:hover:not(:disabled) {
  color: #333;
}

.decision-priority-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 600;
}

.decision-priority-badge.critical {
  background: #fecaca;
  color: #dc2626;
}

.decision-priority-badge.high {
  background: #fed7aa;
  color: #ea580c;
}

.decision-priority-badge.medium {
  background: #fef08a;
  color: #ca8a04;
}

.decision-priority-badge.low {
  background: #e0e7ff;
  color: #4f46e5;
}

.decision-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;
