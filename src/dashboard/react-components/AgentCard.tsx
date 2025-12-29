/**
 * AgentCard Component
 *
 * Displays an agent with hierarchical color coding, status indicator,
 * and attention badge. Inspired by AI Maestro's visual design.
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

export interface AgentCardProps {
  agent: Agent;
  isSelected?: boolean;
  showBreadcrumb?: boolean;
  compact?: boolean;
  displayNameOverride?: string; // Override the displayed name (e.g., strip team prefix)
  onClick?: (agent: Agent) => void;
  onMessageClick?: (agent: Agent) => void;
  onReleaseClick?: (agent: Agent) => void;
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
}: AgentCardProps) {
  const colors = getAgentColor(agent.name);
  const initials = getAgentInitials(agent.name);
  const displayName = displayNameOverride || getAgentDisplayName(agent.name);
  const statusColor = STATUS_COLORS[agent.status] || STATUS_COLORS.offline;

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

  if (compact) {
    return (
      <div
        className={`agent-card-compact ${isSelected ? 'selected' : ''}`}
        onClick={handleClick}
        style={{
          '--agent-primary': colors.primary,
          '--agent-light': colors.light,
        } as React.CSSProperties}
      >
        <div className="agent-avatar-small" style={{ backgroundColor: colors.primary }}>
          <span style={{ color: colors.text }}>{initials}</span>
        </div>
        <div className="agent-compact-info">
          <span className="agent-name">{displayName}</span>
          {/* Hide breadcrumb when displayNameOverride is set (e.g., inside team groups) */}
          {!displayNameOverride && (
            <span className="agent-breadcrumb-compact">{getAgentBreadcrumb(agent.name)}</span>
          )}
        </div>
        <div className="agent-compact-actions">
          {agent.isSpawned && onReleaseClick && (
            <button
              className="release-btn-compact"
              onClick={handleReleaseClick}
              title="Kill agent"
            >
              <ReleaseIcon />
            </button>
          )}
          {agent.isProcessing ? (
            <ThinkingDot isProcessing={true} />
          ) : (
            <div className="agent-status-dot" style={{ backgroundColor: statusColor }} />
          )}
          {agent.needsAttention && <div className="attention-badge" />}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`agent-card ${isSelected ? 'selected' : ''}`}
      onClick={handleClick}
      style={{
        '--agent-primary': colors.primary,
        '--agent-light': colors.light,
        '--agent-dark': colors.dark,
      } as React.CSSProperties}
    >
      <div className="agent-card-header">
        <div className="agent-avatar" style={{ backgroundColor: colors.primary }}>
          <span style={{ color: colors.text }}>{initials}</span>
          <div className="status-indicator" style={{ backgroundColor: statusColor }} />
        </div>
        <div className="agent-info">
          <div className="agent-name-row">
            <span className="agent-display-name">{displayName}</span>
            {agent.needsAttention && (
              <span className="attention-badge" title="Needs attention">!</span>
            )}
          </div>
          {showBreadcrumb ? (
            <span className="agent-breadcrumb">{getAgentBreadcrumb(agent.name)}</span>
          ) : (
            <span className="agent-full-name">{agent.name}</span>
          )}
        </div>
      </div>

      {agent.isProcessing && (
        <div className="agent-thinking">
          <ThinkingIndicator
            isProcessing={true}
            processingStartedAt={agent.processingStartedAt}
            size="medium"
            showElapsed={true}
          />
          <span className="thinking-label">Thinking...</span>
        </div>
      )}

      {agent.currentTask && !agent.isProcessing && (
        <div className="agent-task">
          <span className="task-label">Working on:</span>
          <span className="task-text">{agent.currentTask}</span>
        </div>
      )}

      <div className="agent-card-footer">
        <div className="agent-meta">
          {agent.cli && <span className="agent-cli">{agent.cli}</span>}
          {agent.messageCount !== undefined && agent.messageCount > 0 && (
            <span className="message-count">{agent.messageCount} msgs</span>
          )}
          {agent.isSpawned && <span className="agent-spawned-badge">spawned</span>}
        </div>
        <div className="agent-actions">
          {agent.isSpawned && onReleaseClick && (
            <button className="release-btn" onClick={handleReleaseClick} title="Release agent">
              <ReleaseIcon />
            </button>
          )}
          {onMessageClick && (
            <button className="message-btn" onClick={handleMessageClick} title="Send message">
              <MessageIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Simple message icon SVG
 */
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

/**
 * Release/kill icon SVG - Power/terminate symbol
 */
function ReleaseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className="release-icon"
    >
      {/* Outer ring with gap at top */}
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
      {/* Vertical line (power symbol stem) */}
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

/**
 * CSS styles for the component (can be moved to a CSS file)
 */
export const agentCardStyles = `
.agent-card {
  background: var(--agent-light);
  border: 1px solid var(--agent-primary);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.agent-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  transform: translateY(-1px);
}

.agent-card.selected {
  border-width: 2px;
  box-shadow: 0 0 0 2px var(--agent-light);
}

.agent-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.agent-avatar {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
  position: relative;
}

.agent-avatar-small {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 10px;
}

.status-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid white;
}

.agent-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-display-name {
  font-weight: 600;
  font-size: 14px;
  color: #1a1a1a;
}

.agent-full-name,
.agent-breadcrumb {
  font-size: 12px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.attention-badge {
  background: #ef4444;
  color: white;
  font-size: 10px;
  font-weight: 700;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.agent-task {
  margin-top: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 4px;
  font-size: 12px;
}

.task-label {
  color: #666;
  margin-right: 4px;
}

.task-text {
  color: #1a1a1a;
}

.agent-card-footer {
  margin-top: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.agent-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: #888;
}

.agent-cli {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 4px;
}

.message-count {
  color: var(--agent-primary);
}

.message-btn {
  background: var(--agent-primary);
  color: white;
  border: none;
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;
}

.message-btn:hover {
  opacity: 0.9;
}

.agent-actions {
  display: flex;
  gap: 6px;
}

/* Kill Agent Button - Industrial control panel aesthetic */
.release-btn {
  position: relative;
  background: linear-gradient(180deg, #3a1a1a 0%, #2a0f0f 100%);
  color: #ff6b6b;
  border: 1px solid #4a2020;
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: all 0.2s ease;
  box-shadow:
    inset 0 1px 0 rgba(255, 107, 107, 0.1),
    0 2px 4px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

/* Subtle scanline texture */
.release-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.1) 2px,
    rgba(0, 0, 0, 0.1) 4px
  );
  pointer-events: none;
  opacity: 0.5;
}

/* Warning glow on hover */
.release-btn:hover {
  background: linear-gradient(180deg, #4a2020 0%, #3a1515 100%);
  border-color: #ff4444;
  color: #ff4444;
  box-shadow:
    inset 0 1px 0 rgba(255, 68, 68, 0.2),
    0 0 12px rgba(255, 68, 68, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.4);
  transform: scale(1.05);
}

/* Icon animation on hover */
.release-btn:hover .release-icon {
  animation: killPulse 0.6s ease-in-out infinite;
}

@keyframes killPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* Active/pressed state */
.release-btn:active {
  transform: scale(0.98);
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.4),
    0 0 8px rgba(255, 68, 68, 0.3);
}

.agent-spawned-badge {
  background: var(--color-accent-light, rgba(18, 100, 163, 0.15));
  color: var(--color-accent, #1264a3);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 500;
}

/* Compact variant */
.agent-card-compact {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s;
}

.agent-card-compact:hover {
  background: rgba(74, 158, 255, 0.08);
}

.agent-card-compact.selected {
  background: rgba(74, 158, 255, 0.12);
  border-left: 3px solid var(--agent-primary);
}

.agent-compact-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-card-compact .agent-name {
  font-size: 13px;
  font-weight: 600;
  color: #e8e8e8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-breadcrumb-compact {
  font-size: 10px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-compact-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* Compact Kill Button - Minimal but distinctive */
.release-btn-compact {
  position: relative;
  background: transparent;
  border: 1px solid transparent;
  color: #666;
  padding: 5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  transition: all 0.25s ease;
  opacity: 0;
}

.agent-card-compact:hover .release-btn-compact {
  opacity: 0.7;
}

/* Hover: Transform into danger state */
.release-btn-compact:hover {
  opacity: 1 !important;
  background: linear-gradient(180deg, rgba(255, 68, 68, 0.15) 0%, rgba(180, 40, 40, 0.2) 100%);
  border-color: rgba(255, 68, 68, 0.5);
  color: #ff5555;
  box-shadow: 0 0 10px rgba(255, 68, 68, 0.3);
  transform: scale(1.1);
}

/* Pulsing glow effect on hover */
.release-btn-compact:hover .release-icon {
  animation: killPulseCompact 0.5s ease-in-out infinite;
  filter: drop-shadow(0 0 3px rgba(255, 68, 68, 0.6));
}

@keyframes killPulseCompact {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}

/* Active state */
.release-btn-compact:active {
  transform: scale(0.95);
  background: rgba(255, 68, 68, 0.25);
}

.agent-card-compact .attention-badge {
  width: 8px;
  height: 8px;
}

/* Thinking indicator section */
.agent-thinking {
  margin-top: 8px;
  padding: 8px;
  background: #eef2ff;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid #c7d2fe;
}

.thinking-label {
  font-size: 12px;
  color: #6366f1;
  font-weight: 500;
}
`;
