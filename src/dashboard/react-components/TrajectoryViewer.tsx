/**
 * TrajectoryViewer Component
 *
 * Displays an agent's action history as a timeline,
 * showing tool calls, decisions, and state changes.
 * Uses Tailwind CSS with Mission Control theme.
 */

import React, { useState, useMemo } from 'react';

export interface TrajectoryStep {
  id: string;
  timestamp: string | number;
  type: 'tool_call' | 'decision' | 'message' | 'state_change' | 'error' | 'phase_transition';
  phase?: 'plan' | 'design' | 'execute' | 'review' | 'observe';
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
  compact?: boolean;
}

export function TrajectoryViewer({
  agentName,
  steps,
  isLoading = false,
  onStepClick,
  maxHeight = '400px',
  compact = false,
}: TrajectoryViewerProps) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<TrajectoryStep['type'] | 'all'>('all');

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
    { value: 'phase_transition', label: 'Phases' },
    { value: 'error', label: 'Errors' },
  ];

  return (
    <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-tertiary">
        <div className="flex items-center gap-2">
          <TimelineIcon />
          <span className="font-medium text-sm text-text-primary">Trajectory</span>
          <span className="text-xs text-text-muted bg-bg-elevated px-2 py-0.5 rounded-full">
            {steps.length} steps
          </span>
          {agentName && (
            <span className="text-xs text-text-secondary">• {agentName}</span>
          )}
        </div>
        {!compact && (
          <div className="flex gap-1">
            {typeFilters.map((f) => (
              <button
                key={f.value}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  filter === f.value
                    ? 'bg-accent text-bg-deep'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover border border-border'
                }`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="overflow-y-auto p-4" style={{ maxHeight }}>
        {isLoading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-text-muted">
            <Spinner />
            <span className="text-sm">Loading trajectory...</span>
          </div>
        ) : filteredSteps.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-text-muted">
            <EmptyIcon />
            <span className="text-sm">No steps to display</span>
          </div>
        ) : (
          <div className="flex flex-col">
            {filteredSteps.map((step, index) => (
              <TrajectoryStepItem
                key={step.id}
                step={step}
                isExpanded={expandedSteps.has(step.id)}
                isLast={index === filteredSteps.length - 1}
                compact={compact}
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
  compact?: boolean;
  onToggle: () => void;
  onClick: () => void;
}

function TrajectoryStepItem({
  step,
  isExpanded,
  isLast,
  compact = false,
  onToggle,
  onClick,
}: TrajectoryStepItemProps) {
  const timestamp = formatTimestamp(step.timestamp);
  const icon = getStepIcon(step.type);
  const statusColor = getStatusColor(step.status);
  const phaseColor = getPhaseColor(step.phase);

  return (
    <div className="flex gap-3">
      {/* Timeline line and dot */}
      <div className="flex flex-col items-center w-6">
        <div
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 z-10 ${
            step.status === 'running' ? 'animate-pulse' : ''
          }`}
          style={{
            backgroundColor: statusColor || phaseColor || 'var(--color-bg-elevated)',
            borderColor: statusColor || phaseColor || 'var(--color-accent)',
            color: statusColor || phaseColor ? '#fff' : 'var(--color-accent)',
          }}
        >
          {icon}
        </div>
        {!isLast && <div className="w-0.5 flex-1 bg-border my-1" />}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 ${isLast ? '' : 'pb-4'}`}>
        <button
          className="w-full flex items-center justify-between gap-3 px-3 py-2 bg-bg-tertiary border border-border rounded-md hover:bg-bg-hover hover:border-border-medium transition-colors text-left"
          onClick={onToggle}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-text-primary truncate">
              {step.title}
            </span>
            <span className="text-[10px] text-text-muted bg-bg-elevated px-1.5 py-0.5 rounded flex-shrink-0">
              {formatType(step.type)}
            </span>
            {step.phase && phaseColor && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                style={{
                  backgroundColor: `${phaseColor}20`,
                  color: phaseColor,
                }}
              >
                {step.phase}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {step.duration !== undefined && (
              <span className="text-[10px] font-mono text-text-secondary">
                {formatDuration(step.duration)}
              </span>
            )}
            <span className="text-[10px] text-text-muted">{timestamp}</span>
            {!compact && <ChevronIcon isExpanded={isExpanded} />}
          </div>
        </button>

        {/* Expanded details */}
        {isExpanded && !compact && (
          <div className="mt-2 p-3 bg-bg-tertiary border border-border rounded-md">
            {step.description && (
              <p className="text-sm text-text-secondary mb-3 leading-relaxed">
                {step.description}
              </p>
            )}
            {step.metadata && Object.keys(step.metadata).length > 0 && (
              <div className="bg-bg-elevated rounded p-3 mb-3 overflow-x-auto">
                <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-words">
                  {JSON.stringify(step.metadata, null, 2)}
                </pre>
              </div>
            )}
            <button
              className="px-3 py-1.5 text-xs text-text-secondary bg-bg-elevated border border-border rounded hover:bg-bg-hover hover:text-text-primary transition-colors"
              onClick={onClick}
            >
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
    phase_transition: 'Phase',
    error: 'Error',
  };
  return labels[type];
}

function getStatusColor(status?: TrajectoryStep['status']): string | null {
  switch (status) {
    case 'running':
      return '#ff6b35'; // warning/orange
    case 'success':
      return '#00ffc8'; // success/green
    case 'error':
      return '#ff4757'; // error/red
    default:
      return null;
  }
}

function getPhaseColor(phase?: TrajectoryStep['phase']): string | null {
  switch (phase) {
    case 'plan':
      return '#a855f7'; // purple
    case 'design':
      return '#00d9ff'; // cyan
    case 'execute':
      return '#ff6b35'; // orange
    case 'review':
      return '#00ffc8'; // green
    case 'observe':
      return '#fbbf24'; // yellow
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
    case 'phase_transition':
      return <PhaseIcon />;
    case 'error':
      return <ErrorIcon />;
    default:
      return null;
  }
}

// Icon components (small, 10x10)
function TimelineIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary">
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
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
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
    </svg>
  );
}

function PhaseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" stroke="white" strokeWidth="2" fill="none" />
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
      className={`text-text-muted transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-dim">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
        className="text-accent"
      />
    </svg>
  );
}
