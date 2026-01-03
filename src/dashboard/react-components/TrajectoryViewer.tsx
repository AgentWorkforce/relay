/**
 * TrajectoryViewer Component
 *
 * Displays an agent's action history as a refined timeline,
 * with a distinctive futuristic aesthetic emphasizing clarity and flow.
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

export interface TrajectoryHistoryEntry {
  id: string;
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
  agents?: string[];
  summary?: string;
  confidence?: number;
}

export interface TrajectoryViewerProps {
  agentName: string;
  steps: TrajectoryStep[];
  history?: TrajectoryHistoryEntry[];
  selectedTrajectoryId?: string | null;
  onSelectTrajectory?: (id: string | null) => void;
  isLoading?: boolean;
  onStepClick?: (step: TrajectoryStep) => void;
  compact?: boolean;
}

export function TrajectoryViewer({
  agentName,
  steps,
  history = [],
  selectedTrajectoryId,
  onSelectTrajectory,
  isLoading = false,
  onStepClick,
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

  const typeFilters: { value: TrajectoryStep['type'] | 'all'; label: string; icon: React.ReactNode }[] = [
    { value: 'all', label: 'All', icon: <FilterAllIcon /> },
    { value: 'tool_call', label: 'Tools', icon: <ToolIcon /> },
    { value: 'decision', label: 'Decisions', icon: <DecisionIcon /> },
    { value: 'message', label: 'Messages', icon: <MessageIcon /> },
    { value: 'state_change', label: 'State', icon: <StateIcon /> },
    { value: 'phase_transition', label: 'Phases', icon: <PhaseIcon /> },
    { value: 'error', label: 'Errors', icon: <ErrorIcon /> },
  ];

  // Calculate phase distribution for the mini progress bar
  const phaseStats = useMemo(() => {
    const phases = steps.filter(s => s.phase).reduce((acc, s) => {
      if (s.phase) acc[s.phase] = (acc[s.phase] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const total = Object.values(phases).reduce((a, b) => a + b, 0);
    return { phases, total };
  }, [steps]);

  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-bg-card to-bg-tertiary rounded-xl border border-border/50 overflow-hidden shadow-lg backdrop-blur-sm">
      {/* Header with gradient accent line */}
      <div className="relative">
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-blue-500 via-accent-cyan to-blue-500 opacity-60" />
        
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/30">
          <div className="flex items-center gap-3">
            {/* Back button when viewing a specific trajectory */}
            {selectedTrajectoryId && onSelectTrajectory && (
              <button
                onClick={() => onSelectTrajectory(null)}
                className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-text-muted hover:text-accent-cyan bg-bg-elevated/50 hover:bg-bg-elevated rounded-lg border border-border/30 hover:border-accent-cyan/30 transition-all duration-200"
                title="Back to trajectory list"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>List</span>
              </button>
            )}
            <div className="relative">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500/20 to-accent-cyan/20 flex items-center justify-center border border-blue-500/30">
                <TrajectoryHeaderIcon />
              </div>
              {steps.some(s => s.status === 'running') && (
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-accent-cyan rounded-full animate-pulse shadow-[0_0_8px_rgba(0,217,255,0.6)]" />
              )}
            </div>
            <div className="flex flex-col">
              <span className="font-semibold text-sm text-text-primary tracking-wide">Trajectory</span>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-muted font-mono">
                  {steps.length} {steps.length === 1 ? 'step' : 'steps'}
                </span>
                {agentName && (
                  <>
                    <span className="text-text-dim">|</span>
                    <span className="text-[11px] text-accent-cyan/80 font-medium truncate max-w-[120px]">{agentName}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          
          {/* Mini phase progress indicator */}
          {phaseStats.total > 0 && !compact && (
            <div className="flex items-center gap-1.5">
              {(['plan', 'design', 'execute', 'review', 'observe'] as const).map(phase => {
                const count = phaseStats.phases[phase] || 0;
                const color = getPhaseColor(phase);
                return count > 0 ? (
                  <div
                    key={phase}
                    className="h-1.5 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.max(8, (count / phaseStats.total) * 48)}px`,
                      backgroundColor: color || 'var(--color-border)',
                    }}
                    title={`${phase}: ${count}`}
                  />
                ) : null;
              })}
            </div>
          )}
        </div>

        {/* Filter tabs */}
        {!compact && (
          <div className="flex items-center gap-1 px-4 py-2 bg-bg-elevated/50 border-b border-border/20 overflow-x-auto scrollbar-thin">
            {typeFilters.map((f) => (
              <button
                key={f.value}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg transition-all duration-200 whitespace-nowrap ${
                  filter === f.value
                    ? 'bg-blue-500/20 text-blue-500 border border-blue-500/30 shadow-[0_0_12px_rgba(59,130,246,0.15)]'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover/50'
                }`}
                onClick={() => setFilter(f.value)}
              >
                <span className="opacity-70">{f.icon}</span>
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center gap-4 py-12 text-text-muted">
            <div className="relative">
              <Spinner />
              <div className="absolute inset-0 bg-accent-cyan/10 rounded-full blur-xl" />
            </div>
            <span className="text-sm font-medium">Loading trajectory...</span>
          </div>
        ) : filteredSteps.length === 0 ? (
          <div className="flex flex-col gap-4 py-4 text-text-muted">
            {steps.length === 0 && history.length > 0 ? (
              /* Show trajectory history when no current steps */
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between px-2">
                  <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">Recent Trajectories</span>
                  {selectedTrajectoryId && onSelectTrajectory && (
                    <button
                      onClick={() => onSelectTrajectory(null)}
                      className="text-[10px] text-accent-cyan hover:underline"
                    >
                      ← Back to current
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {history.slice(0, 10).map((entry) => (
                    <button
                      key={entry.id}
                      onClick={() => onSelectTrajectory?.(entry.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 border ${
                        selectedTrajectoryId === entry.id
                          ? 'bg-blue-500/15 border-blue-500/40 text-text-primary'
                          : 'bg-bg-tertiary/50 border-transparent hover:bg-bg-elevated/60 hover:border-border/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-text-primary truncate flex-1">
                          {entry.title}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${
                          entry.status === 'completed'
                            ? 'bg-green-500/15 text-green-500'
                            : entry.status === 'active'
                            ? 'bg-blue-500/15 text-blue-500'
                            : 'bg-amber-500/15 text-amber-500'
                        }`}>
                          {entry.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-text-dim">
                          {formatRelativeTime(entry.startedAt)}
                        </span>
                        {entry.confidence && (
                          <span className="text-[10px] text-text-dim">
                            • {Math.round(entry.confidence * 100)}% confidence
                          </span>
                        )}
                      </div>
                      {entry.summary && (
                        <p className="text-[11px] text-text-muted mt-1 line-clamp-2">
                          {entry.summary}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : steps.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-4 py-8">
                <div className="w-16 h-16 rounded-2xl bg-bg-elevated/50 flex items-center justify-center border border-border/30">
                  <EmptyIcon />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-text-secondary">No steps recorded</p>
                  <p className="text-xs text-text-dim mt-1">Steps will appear here as the agent works</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 py-8">
                <div className="w-16 h-16 rounded-2xl bg-bg-elevated/50 flex items-center justify-center border border-border/30">
                  <EmptyIcon />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-text-secondary">No matching steps</p>
                  <p className="text-xs text-text-dim mt-1">Try a different filter or select "All"</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filteredSteps.map((step, index) => (
              <TrajectoryStepItem
                key={step.id}
                step={step}
                isExpanded={expandedSteps.has(step.id)}
                isLast={index === filteredSteps.length - 1}
                isFirst={index === 0}
                compact={compact}
                onToggle={() => toggleStep(step.id)}
                onClick={onStepClick ? () => onStepClick(step) : undefined}
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
  isFirst?: boolean;
  compact?: boolean;
  onToggle: () => void;
  onClick?: () => void;
}

function TrajectoryStepItem({
  step,
  isExpanded,
  isLast,
  isFirst = false,
  compact = false,
  onToggle,
  onClick,
}: TrajectoryStepItemProps) {
  const timestamp = formatTimestamp(step.timestamp);
  const icon = getStepIcon(step.type);
  const statusColor = getStatusColor(step.status);
  const phaseColor = getPhaseColor(step.phase);
  const typeColor = getTypeColor(step.type);
  const hasMetadata = step.metadata && Object.keys(step.metadata).length > 0;
  const hasDetailContent = !!step.description || hasMetadata || !!onClick;

  return (
    <div className="flex gap-3 group">
      {/* Timeline line and node */}
      <div className="flex flex-col items-center w-7 relative">
        {/* Connecting line above (if not first) */}
        {!isFirst && (
          <div 
            className="absolute top-0 w-px h-2 transition-colors"
            style={{ backgroundColor: phaseColor ? `${phaseColor}40` : 'var(--color-border)' }}
          />
        )}
        
        {/* Node */}
        <div
          className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 z-10 mt-2 transition-all duration-200 ${
            step.status === 'running' 
              ? 'animate-pulse shadow-[0_0_12px_rgba(0,217,255,0.4)]' 
              : 'group-hover:scale-110'
          }`}
          style={{
            background: statusColor 
              ? `linear-gradient(135deg, ${statusColor}40, ${statusColor}20)`
              : phaseColor 
                ? `linear-gradient(135deg, ${phaseColor}30, ${phaseColor}10)`
                : `linear-gradient(135deg, ${typeColor}30, ${typeColor}10)`,
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: statusColor || phaseColor || typeColor || 'var(--color-border)',
            color: statusColor || phaseColor || typeColor || 'var(--color-text-secondary)',
          }}
        >
          {icon}
        </div>
        
        {/* Connecting line below (if not last) */}
        {!isLast && (
          <div 
            className="w-px flex-1 mt-1 transition-colors"
            style={{ 
              background: `linear-gradient(to bottom, ${phaseColor || typeColor || 'var(--color-border)'}40, transparent)` 
            }}
          />
        )}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 pt-1 ${isLast ? 'pb-1' : 'pb-3'}`}>
        <button
          className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 text-left border ${
            isExpanded 
              ? 'bg-bg-elevated/80 border-border/60 shadow-sm' 
              : 'bg-bg-tertiary/50 border-transparent hover:bg-bg-elevated/60 hover:border-border/40'
          }`}
          onClick={onToggle}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-[13px] font-medium text-text-primary truncate">
              {step.title}
            </span>
            <span 
              className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
              style={{
                backgroundColor: `${typeColor}15`,
                color: typeColor,
              }}
            >
              {formatType(step.type)}
            </span>
            {step.phase && phaseColor && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
                style={{
                  backgroundColor: `${phaseColor}15`,
                  color: phaseColor,
                }}
              >
                {step.phase}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {step.duration !== undefined && (
              <span className="text-[10px] font-mono text-text-muted px-1.5 py-0.5 bg-bg-elevated/50 rounded">
                {formatDuration(step.duration)}
              </span>
            )}
            <span className="text-[10px] text-text-dim">{timestamp}</span>
            {!compact && <ChevronIcon isExpanded={isExpanded} />}
          </div>
        </button>

        {/* Expanded details */}
        {isExpanded && !compact && hasDetailContent && (
          <div className="mt-2 ml-1 pl-3 border-l-2 border-border/30">
            {step.description && (
              <p className="text-[13px] text-text-secondary mb-3 leading-relaxed">
                {step.description}
              </p>
            )}
            {hasMetadata && (
              <div className="bg-bg-elevated/50 rounded-lg p-3 mb-3 overflow-x-auto border border-border/20">
                <pre className="text-[11px] font-mono text-text-muted whitespace-pre-wrap break-words leading-relaxed">
                  {JSON.stringify(step.metadata, null, 2)}
                </pre>
              </div>
            )}
            {onClick && (
              <button
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-accent-cyan bg-accent-cyan/10 border border-accent-cyan/20 rounded-md hover:bg-accent-cyan/20 hover:border-accent-cyan/30 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onClick();
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                View Details
              </button>
            )}
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

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
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
      return '#3b82f6'; // blue
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

function getTypeColor(type: TrajectoryStep['type']): string {
  switch (type) {
    case 'tool_call':
      return '#00d9ff'; // cyan
    case 'decision':
      return '#3b82f6'; // blue
    case 'message':
      return '#3b82f6'; // blue
    case 'state_change':
      return '#10b981'; // emerald
    case 'phase_transition':
      return '#f59e0b'; // amber
    case 'error':
      return '#ef4444'; // red
    default:
      return '#6b7280'; // gray
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

// Icon components
function TrajectoryHeaderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-500">
      <path d="M3 12h4l3 9 4-18 3 9h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FilterAllIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4m0 12v4m-7.07-14.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function DecisionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7-6.3-4.6L5.7 21l2.3-7-6-4.6h7.6z" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function StateIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <path d="M9 12h6m-3-3v6" />
    </svg>
  );
}

function PhaseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <circle cx="12" cy="16" r="0.5" fill="currentColor" />
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
