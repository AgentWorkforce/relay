/**
 * TrajectoryViewer Component
 *
 * Displays an agent's action history as a timeline,
 * showing tool calls, decisions, and state changes.
 */

import React, { useState, useMemo } from 'react';
import { getAgentColor } from '../lib/colors';

export interface TrajectoryStep {
  id: string;
  timestamp: string | number;
  type: 'tool_call' | 'decision' | 'message' | 'state_change' | 'error';
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  duration?: number;
  status?: 'pending' | 'running' | 'success' | 'error';
}

export interface TrajectoryViewerProps {
  agentName: string;
  steps: TrajectoryStep[];
  isLoading?: boolean;
  onStepClick?: (step: TrajectoryStep) => void;
  maxHeight?: string;
}

export function TrajectoryViewer({
  agentName,
  steps,
  isLoading = false,
  onStepClick,
  maxHeight = '400px',
}: TrajectoryViewerProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<TrajectoryStep['type'] | 'all'>('all');

  const colors = getAgentColor(agentName);

  // Filter steps
  const filteredSteps = useMemo(() => {
    if (filter === 'all') return steps;
    return steps.filter((s) => s.type === filter);
  }, [steps, filter]);

  // Toggle step expansion
  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  const typeFilters: { value: TrajectoryStep['type'] | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'tool_call', label: 'Tools' },
    { value: 'decision', label: 'Decisions' },
    { value: 'message', label: 'Messages' },
    { value: 'state_change', label: 'State' },
    { value: 'error', label: 'Errors' },
  ];

  return (
    <div className="trajectory-viewer">
      <div className="trajectory-header">
        <div className="trajectory-title">
          <TimelineIcon />
          <span>Trajectory</span>
          <span className="trajectory-count">{steps.length} steps</span>
        </div>
        <div className="trajectory-filters">
          {typeFilters.map((f) => (
            <button
              key={f.value}
              className={`trajectory-filter ${filter === f.value ? 'active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="trajectory-timeline" style={{ maxHeight }}>
        {isLoading ? (
          <div className="trajectory-loading">
            <Spinner />
            <span>Loading trajectory...</span>
          </div>
        ) : filteredSteps.length === 0 ? (
          <div className="trajectory-empty">
            <EmptyIcon />
            <span>No steps to display</span>
          </div>
        ) : (
          <div className="trajectory-steps">
            {filteredSteps.map((step, index) => (
              <TrajectoryStepItem
                key={step.id}
                step={step}
                isExpanded={expandedSteps.has(step.id)}
                isLast={index === filteredSteps.length - 1}
                accentColor={colors.primary}
                onToggle={() => toggleStep(step.id)}
                onClick={() => onStepClick?.(step)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface TrajectoryStepItemProps {
  step: TrajectoryStep;
  isExpanded: boolean;
  isLast: boolean;
  accentColor: string;
  onToggle: () => void;
  onClick: () => void;
}

function TrajectoryStepItem({
  step,
  isExpanded,
  isLast,
  accentColor,
  onToggle,
  onClick,
}: TrajectoryStepItemProps) {
  const timestamp = formatTimestamp(step.timestamp);
  const icon = getStepIcon(step.type);
  const statusColor = getStatusColor(step.status);

  return (
    <div className={`trajectory-step ${step.status || ''}`}>
      <div className="trajectory-step-line">
        <div
          className="trajectory-step-dot"
          style={{
            backgroundColor: statusColor || accentColor,
            borderColor: statusColor || accentColor,
          }}
        >
          {icon}
        </div>
        {!isLast && <div className="trajectory-step-connector" />}
      </div>

      <div className="trajectory-step-content">
        <button className="trajectory-step-header" onClick={onToggle}>
          <div className="trajectory-step-info">
            <span className="trajectory-step-title">{step.title}</span>
            <span className="trajectory-step-type">{formatType(step.type)}</span>
          </div>
          <div className="trajectory-step-meta">
            {step.duration !== undefined && (
              <span className="trajectory-step-duration">{formatDuration(step.duration)}</span>
            )}
            <span className="trajectory-step-time">{timestamp}</span>
            <ChevronIcon isExpanded={isExpanded} />
          </div>
        </button>

        {isExpanded && (
          <div className="trajectory-step-details">
            {step.description && (
              <p className="trajectory-step-desc">{step.description}</p>
            )}
            {step.metadata && Object.keys(step.metadata).length > 0 && (
              <div className="trajectory-step-metadata">
                <pre>{JSON.stringify(step.metadata, null, 2)}</pre>
              </div>
            )}
            <button className="trajectory-step-action" onClick={onClick}>
              View Details
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Helper functions
function formatTimestamp(ts: string | number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatType(type: TrajectoryStep['type']): string {
  const labels: Record<TrajectoryStep['type'], string> = {
    tool_call: 'Tool',
    decision: 'Decision',
    message: 'Message',
    state_change: 'State',
    error: 'Error',
  };
  return labels[type];
}

function getStatusColor(status?: TrajectoryStep['status']): string | null {
  switch (status) {
    case 'running':
      return '#f59e0b';
    case 'success':
      return '#10b981';
    case 'error':
      return '#ef4444';
    default:
      return null;
  }
}

function getStepIcon(type: TrajectoryStep['type']): React.ReactNode {
  switch (type) {
    case 'tool_call':
      return <ToolIcon />;
    case 'decision':
      return <DecisionIcon />;
    case 'message':
      return <MessageIcon />;
    case 'state_change':
      return <StateIcon />;
    case 'error':
      return <ErrorIcon />;
    default:
      return null;
  }
}

// Icon components
function TimelineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function DecisionIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="white" strokeWidth="2" fill="none" />
      <circle cx="12" cy="17" r="1" fill="white" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function StateIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="9" x2="15" y2="15" stroke="white" strokeWidth="2" />
      <line x1="15" y1="9" x2="9" y2="15" stroke="white" strokeWidth="2" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" stroke="white" strokeWidth="2" />
      <circle cx="12" cy="16" r="1" fill="white" />
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

function EmptyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="trajectory-spinner" width="20" height="20" viewBox="0 0 24 24">
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
 * CSS styles for the trajectory viewer
 */
export const trajectoryViewerStyles = `
.trajectory-viewer {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
  overflow: hidden;
}

.trajectory-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
}

.trajectory-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.trajectory-title svg {
  color: #666;
}

.trajectory-count {
  font-weight: 400;
  font-size: 12px;
  color: #888;
  background: #f0f0f0;
  padding: 2px 8px;
  border-radius: 10px;
}

.trajectory-filters {
  display: flex;
  gap: 4px;
}

.trajectory-filter {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.trajectory-filter:hover {
  background: #f5f5f5;
  color: #333;
}

.trajectory-filter.active {
  background: #1264a3;
  border-color: #1264a3;
  color: #ffffff;
}

.trajectory-timeline {
  overflow-y: auto;
  padding: 16px;
}

.trajectory-loading,
.trajectory-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: #888;
  font-size: 13px;
}

.trajectory-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.trajectory-steps {
  display: flex;
  flex-direction: column;
}

.trajectory-step {
  display: flex;
  gap: 12px;
}

.trajectory-step-line {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 24px;
}

.trajectory-step-dot {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  color: #ffffff;
  flex-shrink: 0;
  z-index: 1;
}

.trajectory-step-connector {
  width: 2px;
  flex: 1;
  background: #e8e8e8;
  margin: 4px 0;
}

.trajectory-step-content {
  flex: 1;
  min-width: 0;
  padding-bottom: 16px;
}

.trajectory-step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: all 0.15s;
}

.trajectory-step-header:hover {
  background: #f5f5f5;
  border-color: #d0d0d0;
}

.trajectory-step-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.trajectory-step-title {
  font-size: 13px;
  font-weight: 500;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trajectory-step-type {
  font-size: 11px;
  color: #888;
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}

.trajectory-step-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.trajectory-step-duration {
  font-size: 11px;
  color: #666;
  font-family: monospace;
}

.trajectory-step-time {
  font-size: 11px;
  color: #888;
}

.trajectory-step-details {
  margin-top: 8px;
  padding: 12px;
  background: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
}

.trajectory-step-desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: #555;
  line-height: 1.5;
}

.trajectory-step-metadata {
  background: #f5f5f5;
  border-radius: 4px;
  padding: 12px;
  margin-bottom: 12px;
  overflow-x: auto;
}

.trajectory-step-metadata pre {
  margin: 0;
  font-size: 12px;
  font-family: 'SF Mono', monospace;
  color: #333;
  white-space: pre-wrap;
  word-break: break-word;
}

.trajectory-step-action {
  padding: 6px 12px;
  background: #ffffff;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.trajectory-step-action:hover {
  background: #f5f5f5;
  color: #333;
}

.trajectory-step.running .trajectory-step-dot {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.8; }
}

.trajectory-step.error .trajectory-step-header {
  border-color: #fecaca;
  background: #fef2f2;
}
`;
