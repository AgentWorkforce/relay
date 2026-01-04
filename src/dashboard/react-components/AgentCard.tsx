/**
 * AgentCard Component
 *
 * Displays an agent with a distinctive neural/holographic design language.
 * Features gradient backgrounds, animated status indicators, and depth effects.
 */

import React from 'react';
import type { Agent } from '../types';
import {
  getAgentColor,
  getAgentInitials,
  STATUS_COLORS,
  type AgentStatus,
} from '../lib/colors';
import { getAgentDisplayName, getAgentBreadcrumb } from '../lib/hierarchy';
import { ThinkingIndicator, ThinkingDot } from './ThinkingIndicator';
import { getStuckDuration, formatStuckDuration } from '../lib/stuckDetection';

export interface AgentCardProps {
  agent: Agent;
  isSelected?: boolean;
  showBreadcrumb?: boolean;
  compact?: boolean;
  displayNameOverride?: string;
  onClick?: (agent: Agent) => void;
  onMessageClick?: (agent: Agent) => void;
  onReleaseClick?: (agent: Agent) => void;
  onLogsClick?: (agent: Agent) => void;
  onProfileClick?: (agent: Agent) => void;
}

/**
 * Get a descriptive tooltip for an agent's connection status.
 */
function getStatusTooltip(status: AgentStatus, isProcessing?: boolean, isStuck?: boolean, stuckDuration?: number): string {
  if (isStuck && stuckDuration) {
    return `Stuck - Agent received message ${formatStuckDuration(stuckDuration)} ago but hasn't responded`;
  }
  if (isProcessing) {
    return 'Processing - Agent is actively working';
  }
  switch (status) {
    case 'online':
      return 'Connected - Agent is online and ready';
    case 'offline':
      return 'Disconnected - Agent is not connected';
    case 'busy':
      return 'Busy - Agent is occupied with a task';
    case 'processing':
      return 'Processing - Agent is actively working';
    case 'error':
      return 'Error - Agent encountered an error';
    case 'attention':
      return 'Attention - Agent requires user input';
    case 'stuck':
      return 'Stuck - Agent may be blocked or unresponsive';
    default:
      return `Status: ${status}`;
  }
}

export function AgentCard({
  agent,
  isSelected = false,
  showBreadcrumb = false,
  compact = false,
  displayNameOverride,
  onClick,
  onMessageClick,
  onReleaseClick,
  onLogsClick,
  onProfileClick,
}: AgentCardProps) {
  const colors = getAgentColor(agent.name);
  const initials = getAgentInitials(agent.name);
  const displayName = displayNameOverride || getAgentDisplayName(agent.name);
  const stuckDuration = getStuckDuration(agent);
  const isStuck = agent.isStuck || stuckDuration > 0;
  const statusColor = isStuck ? STATUS_COLORS.stuck : (STATUS_COLORS[agent.status] || STATUS_COLORS.offline);
  const isOnline = agent.status === 'online';
  const statusTooltip = getStatusTooltip(agent.status, agent.isProcessing, isStuck, stuckDuration);

  const handleClick = () => {
    onClick?.(agent);
  };

  const handleMessageClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onMessageClick?.(agent);
  };

  const handleReleaseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onReleaseClick?.(agent);
  };

  const handleLogsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onLogsClick?.(agent);
  };

  const handleProfileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onProfileClick?.(agent);
  };

  if (compact) {
    return (
      <div
        className={`
          group relative flex items-center gap-3 py-2.5 px-3 rounded-lg cursor-pointer
          transition-all duration-300 ease-out
          hover:bg-gradient-to-r hover:from-[rgba(255,255,255,0.03)] hover:to-transparent
          ${isSelected
            ? 'bg-gradient-to-r from-[rgba(255,255,255,0.06)] to-transparent'
            : ''
          }
        `}
        onClick={handleClick}
        style={{
          borderLeft: isSelected ? `2px solid ${colors.primary}` : '2px solid transparent',
          boxShadow: isSelected ? `inset 4px 0 12px -4px ${colors.primary}40` : 'none',
        }}
      >
        {/* Agent Avatar with Glow */}
        <div className="relative">
          <div
            className={`
              w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[11px] tracking-wide
              transition-all duration-300 relative overflow-hidden
              ${isOnline ? 'shadow-lg' : 'opacity-60'}
            `}
            style={{
              background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}99)`,
              boxShadow: isOnline ? `0 2px 12px ${colors.primary}50` : 'none',
            }}
          >
            {/* Subtle shine effect */}
            <div
              className="absolute inset-0 opacity-30"
              style={{
                background: 'linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%)',
              }}
            />
            <span className="relative z-10" style={{ color: colors.text }}>{initials}</span>
          </div>
          {/* Status Ring */}
          {isOnline && (
            <div
              className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bg-primary"
              style={{
                backgroundColor: statusColor,
                boxShadow: `0 0 8px ${statusColor}`,
              }}
              title={statusTooltip}
            />
          )}
        </div>

        {/* Agent Info */}
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span
            className={`
              text-[13px] font-semibold tracking-tight truncate transition-colors duration-200
              ${isOnline ? 'text-text-primary' : 'text-text-secondary'}
            `}
          >
            {displayName}
          </span>
          {!displayNameOverride && (
            <span className="text-[10px] text-text-muted truncate font-mono opacity-70">
              {getAgentBreadcrumb(agent.name)}
            </span>
          )}
        </div>

        {/* Actions & Status */}
        <div className="flex items-center gap-2 shrink-0">
          {onProfileClick && (
            <button
              className="relative bg-transparent border border-transparent text-text-dim p-1.5 cursor-pointer
                         flex items-center justify-center rounded-md transition-all duration-200
                         opacity-0 group-hover:opacity-100
                         hover:bg-[#a855f7]/10 hover:border-[#a855f7]/30 hover:text-[#a855f7]
                         hover:shadow-[0_0_12px_rgba(168,85,247,0.25)]"
              onClick={handleProfileClick}
              title="View profile"
            >
              <ProfileIcon />
            </button>
          )}
          {agent.isSpawned && onLogsClick && (
            <button
              className="relative bg-transparent border border-transparent text-text-dim p-1.5 cursor-pointer
                         flex items-center justify-center rounded-md transition-all duration-200
                         opacity-0 group-hover:opacity-100
                         hover:bg-accent-cyan/10 hover:border-accent-cyan/30 hover:text-accent-cyan
                         hover:shadow-[0_0_12px_rgba(0,217,255,0.25)]"
              onClick={handleLogsClick}
              title="View logs"
            >
              <LogsIcon />
            </button>
          )}
          {agent.isSpawned && onReleaseClick && (
            <button
              className="relative bg-transparent border border-transparent text-text-dim p-1.5 cursor-pointer
                         flex items-center justify-center rounded-md transition-all duration-200
                         opacity-0 group-hover:opacity-100
                         hover:bg-error/10 hover:border-error/30 hover:text-error
                         hover:shadow-[0_0_12px_rgba(255,68,68,0.25)]"
              onClick={handleReleaseClick}
              title="Kill agent"
            >
              <ReleaseIcon />
            </button>
          )}
          {agent.isProcessing ? (
            <div title={statusTooltip}>
              <ThinkingDot isProcessing={true} />
            </div>
          ) : (
            <div
              className={`
                w-2 h-2 rounded-full transition-all duration-300
                ${isOnline ? 'animate-pulse' : ''}
              `}
              style={{
                backgroundColor: statusColor,
                boxShadow: isOnline ? `0 0 6px ${statusColor}` : 'none',
              }}
              title={statusTooltip}
            />
          )}
          {agent.needsAttention && (
            <div
              className="w-2 h-2 rounded-full bg-warning animate-pulse shadow-[0_0_8px_rgba(255,107,53,0.5)]"
              title="Needs Attention - Agent requires user input or has pending decisions"
            />
          )}
          {isStuck && (
            <div
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#f97316]/20 text-[#f97316] text-[10px] font-medium animate-pulse"
              title={statusTooltip}
            >
              <StuckIcon />
              <span>{formatStuckDuration(stuckDuration)}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`
        rounded-lg p-3 cursor-pointer transition-all duration-200
        hover:shadow-md hover:-translate-y-px
        ${isSelected ? 'border-2 shadow-[0_0_0_2px_rgba(74,158,255,0.15)]' : 'border'}
      `}
      onClick={handleClick}
      style={{
        backgroundColor: colors.light,
        borderColor: colors.primary,
      }}
    >
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center font-semibold text-sm relative"
          style={{ backgroundColor: colors.primary }}
        >
          <span style={{ color: colors.text }}>{initials}</span>
          <div
            className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white"
            style={{ backgroundColor: statusColor }}
            title={statusTooltip}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-text-primary">{displayName}</span>
            {agent.needsAttention && (
              <span className="bg-red-500 text-white text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center" title="Needs Attention - Agent requires user input or has pending decisions">!</span>
            )}
            {isStuck && (
              <span className="bg-[#f97316] text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1" title={statusTooltip}>
                <StuckIcon /> {formatStuckDuration(stuckDuration)}
              </span>
            )}
          </div>
          {showBreadcrumb ? (
            <span className="text-xs text-text-muted truncate block">{getAgentBreadcrumb(agent.name)}</span>
          ) : (
            <span className="text-xs text-text-muted truncate block">{agent.name}</span>
          )}
          {agent.agentId && (
            <span className="text-[10px] text-text-muted font-mono opacity-70" title="Agent ID (use to resume)">
              ID: {agent.agentId}
            </span>
          )}
        </div>
      </div>

      {agent.isProcessing && (
        <div className="mt-2 p-2 bg-indigo-50 rounded flex items-center gap-2 border border-indigo-200">
          <ThinkingIndicator
            isProcessing={true}
            processingStartedAt={agent.processingStartedAt}
            size="medium"
            showElapsed={true}
          />
          <span className="text-xs text-indigo-500 font-medium">Thinking...</span>
        </div>
      )}

      {agent.currentTask && !agent.isProcessing && (
        <div className="mt-2 p-2 bg-bg-hover rounded text-xs">
          <span className="text-text-muted mr-1">Working on:</span>
          <span className="text-text-primary line-clamp-2" title={agent.currentTask}>{agent.currentTask}</span>
        </div>
      )}

      <div className="mt-3 flex justify-between items-center">
        <div className="flex gap-2 text-xs text-text-muted">
          {agent.cli && <span className="bg-bg-hover py-0.5 px-1.5 rounded">{agent.cli}</span>}
          {agent.messageCount !== undefined && agent.messageCount > 0 && (
            <span style={{ color: colors.primary }}>{agent.messageCount} msgs</span>
          )}
          {agent.isSpawned && (
            <span className="bg-accent-light text-accent text-[10px] py-0.5 px-1.5 rounded uppercase font-medium">spawned</span>
          )}
        </div>
        <div className="flex gap-1.5">
          {onProfileClick && (
            <button
              className="relative bg-gradient-to-b from-[#2a1a3a] to-[#1a0f2a] text-[#a855f7] border border-[#402060] rounded-md py-1.5 px-2.5 cursor-pointer flex items-center justify-center gap-1 transition-all duration-200 shadow-[inset_0_1px_0_rgba(168,85,247,0.1),0_2px_4px_rgba(0,0,0,0.3)] overflow-hidden hover:bg-gradient-to-b hover:from-[#402060] hover:to-[#301a50] hover:border-[#a855f7] hover:shadow-[inset_0_1px_0_rgba(168,85,247,0.2),0_0_12px_rgba(168,85,247,0.4),0_2px_8px_rgba(0,0,0,0.4)] hover:scale-105 active:scale-[0.98]"
              onClick={handleProfileClick}
              title="View profile"
            >
              <ProfileIcon />
            </button>
          )}
          {agent.isSpawned && onLogsClick && (
            <button
              className="relative bg-gradient-to-b from-[#1a2a3a] to-[#0f1a2a] text-accent-cyan border border-[#204060] rounded-md py-1.5 px-2.5 cursor-pointer flex items-center justify-center gap-1 transition-all duration-200 shadow-[inset_0_1px_0_rgba(0,217,255,0.1),0_2px_4px_rgba(0,0,0,0.3)] overflow-hidden hover:bg-gradient-to-b hover:from-[#204060] hover:to-[#1a3a50] hover:border-accent-cyan hover:shadow-[inset_0_1px_0_rgba(0,217,255,0.2),0_0_12px_rgba(0,217,255,0.4),0_2px_8px_rgba(0,0,0,0.4)] hover:scale-105 active:scale-[0.98]"
              onClick={handleLogsClick}
              title="View logs"
            >
              <LogsIcon />
            </button>
          )}
          {agent.isSpawned && onReleaseClick && (
            <button
              className="relative bg-gradient-to-b from-[#3a1a1a] to-[#2a0f0f] text-[#ff6b6b] border border-[#4a2020] rounded-md py-1.5 px-2.5 cursor-pointer flex items-center justify-center gap-1 transition-all duration-200 shadow-[inset_0_1px_0_rgba(255,107,107,0.1),0_2px_4px_rgba(0,0,0,0.3)] overflow-hidden hover:bg-gradient-to-b hover:from-[#4a2020] hover:to-[#3a1515] hover:border-[#ff4444] hover:text-[#ff4444] hover:shadow-[inset_0_1px_0_rgba(255,68,68,0.2),0_0_12px_rgba(255,68,68,0.4),0_2px_8px_rgba(0,0,0,0.4)] hover:scale-105 active:scale-[0.98]"
              onClick={handleReleaseClick}
              title="Release agent"
            >
              <ReleaseIcon />
            </button>
          )}
          {onMessageClick && (
            <button
              className="text-white border-none rounded py-1 px-2 cursor-pointer flex items-center justify-center transition-opacity duration-200 hover:opacity-90"
              style={{ backgroundColor: colors.primary }}
              onClick={handleMessageClick}
              title="Send message"
            >
              <MessageIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ReleaseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className="release-icon"
    >
      <path
        d="M12 22c5.523 0 10-4.477 10-10a9.96 9.96 0 0 0-3-7.141"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M12 22C6.477 22 2 17.523 2 12a9.96 9.96 0 0 1 3-7.141"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="12"
        y1="2"
        x2="12"
        y2="12"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function StuckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
