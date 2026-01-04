/**
 * AgentProfilePanel Component
 *
 * Slide-out panel showing agent profile details.
 * Displays avatar, name, status, spawn prompt, persona, and other metadata.
 * Similar to Slack's user profile panel.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { Agent } from '../types';
import {
  getAgentColor,
  getAgentInitials,
  STATUS_COLORS,
} from '../lib/colors';
import { getAgentDisplayName, getAgentBreadcrumb } from '../lib/hierarchy';

export interface AgentProfilePanelProps {
  /** Agent to display (null to hide panel) */
  agent: Agent | null;
  /** Callback when panel should close */
  onClose: () => void;
  /** Callback when message button is clicked */
  onMessage?: (agent: Agent) => void;
  /** Callback when logs button is clicked */
  onLogs?: (agent: Agent) => void;
  /** Callback when release button is clicked */
  onRelease?: (agent: Agent) => void;
}

export function AgentProfilePanel({
  agent,
  onClose,
  onMessage,
  onLogs,
  onRelease,
}: AgentProfilePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [showFullPrompt, setShowFullPrompt] = useState(false);
  const [showFullPersona, setShowFullPersona] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (agent) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [agent, onClose]);

  // Close on outside click
  const justOpenedRef = useRef(false);

  useEffect(() => {
    if (agent) {
      justOpenedRef.current = true;
      setShowFullPrompt(false);
      setShowFullPersona(false);
    }
  }, [agent]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (justOpenedRef.current) {
        justOpenedRef.current = false;
        return;
      }

      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (agent) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [agent, onClose]);

  if (!agent) {
    return null;
  }

  const colors = getAgentColor(agent.name);
  const initials = getAgentInitials(agent.name);
  const displayName = getAgentDisplayName(agent.name);
  const breadcrumb = getAgentBreadcrumb(agent.name);
  const statusColor = STATUS_COLORS[agent.status] || STATUS_COLORS.offline;
  const isOnline = agent.status === 'online';
  const profile = agent.profile;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed right-0 top-0 h-full w-96 bg-[#1a1d21] border-l border-white/10 shadow-2xl z-50 flex flex-col animate-slide-in-right"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-[#d1d2d3]">Agent Profile</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/10 rounded-md transition-colors text-[#d1d2d3]"
            title="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Agent Info */}
        <div className="flex flex-col items-center p-6 border-b border-white/10">
          {/* Large Avatar */}
          <div className="relative mb-4">
            <div
              className="w-24 h-24 rounded-2xl flex items-center justify-center text-3xl font-bold shadow-lg"
              style={{
                background: `linear-gradient(135deg, ${colors.primary}, ${colors.primary}99)`,
                boxShadow: isOnline ? `0 4px 20px ${colors.primary}50` : 'none',
              }}
            >
              <span style={{ color: colors.text }}>{initials}</span>
            </div>
            {/* Status indicator */}
            <div
              className={`absolute bottom-1 right-1 w-5 h-5 rounded-full border-4 border-[#1a1d21] ${isOnline ? 'animate-pulse' : ''}`}
              style={{
                backgroundColor: statusColor,
                boxShadow: isOnline ? `0 0 8px ${statusColor}` : 'none',
              }}
            />
          </div>

          {/* Name */}
          <h3 className="text-xl font-semibold text-[#d1d2d3] mb-1">
            {displayName}
          </h3>

          {/* Breadcrumb */}
          {breadcrumb && (
            <span className="text-sm text-[#8d8d8e] font-mono mb-2">
              {breadcrumb}
            </span>
          )}

          {/* Title/Role */}
          {profile?.title && (
            <span className="text-sm text-[#a855f7] font-medium mb-2">
              {profile.title}
            </span>
          )}

          {/* Status */}
          <span
            className="text-sm flex items-center gap-1.5"
            style={{ color: statusColor }}
          >
            <div
              className={`w-2 h-2 rounded-full ${isOnline ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: statusColor }}
            />
            {agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
            {agent.isProcessing && ' - Thinking...'}
          </span>

          {/* Tags */}
          <div className="flex flex-wrap gap-2 mt-3">
            {agent.cli && (
              <span className="text-xs bg-[#2a2d31] text-[#d1d2d3] px-2 py-1 rounded">
                {agent.cli}
              </span>
            )}
            {agent.isSpawned && (
              <span className="text-xs bg-[#a855f7]/20 text-[#a855f7] px-2 py-1 rounded uppercase font-medium">
                Spawned
              </span>
            )}
            {agent.team && (
              <span className="text-xs bg-[#00d9ff]/20 text-[#00d9ff] px-2 py-1 rounded">
                {agent.team}
              </span>
            )}
            {profile?.personaName && (
              <span className="text-xs bg-[#10b981]/20 text-[#10b981] px-2 py-1 rounded">
                {profile.personaName}
              </span>
            )}
          </div>
        </div>

        {/* Details - Scrollable */}
        <div className="flex-1 p-4 overflow-y-auto">
          <div className="space-y-4">
            {/* Description */}
            {profile?.description && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Description</label>
                <p className="text-sm text-[#d1d2d3] mt-1">
                  {profile.description}
                </p>
              </div>
            )}

            {/* Current Task */}
            {agent.currentTask && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Current Task</label>
                <p className="text-sm text-[#d1d2d3] mt-1 bg-[#2a2d31] p-2 rounded">
                  {agent.currentTask}
                </p>
              </div>
            )}

            {/* Spawn Prompt */}
            {profile?.spawnPrompt && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide flex items-center justify-between">
                  <span>Spawn Prompt</span>
                  {profile.spawnPrompt.length > 200 && (
                    <button
                      onClick={() => setShowFullPrompt(!showFullPrompt)}
                      className="text-[#a855f7] hover:text-[#c084fc] text-xs font-normal"
                    >
                      {showFullPrompt ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </label>
                <pre className={`text-sm text-[#d1d2d3] mt-1 bg-[#2a2d31] p-3 rounded font-mono whitespace-pre-wrap ${!showFullPrompt && profile.spawnPrompt.length > 200 ? 'line-clamp-4' : ''}`}>
                  {profile.spawnPrompt}
                </pre>
              </div>
            )}

            {/* Persona Prompt */}
            {profile?.personaPrompt && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide flex items-center justify-between">
                  <span>Agent Persona</span>
                  {profile.personaPrompt.length > 200 && (
                    <button
                      onClick={() => setShowFullPersona(!showFullPersona)}
                      className="text-[#a855f7] hover:text-[#c084fc] text-xs font-normal"
                    >
                      {showFullPersona ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </label>
                <pre className={`text-sm text-[#d1d2d3] mt-1 bg-[#2a2d31] p-3 rounded font-mono whitespace-pre-wrap ${!showFullPersona && profile.personaPrompt.length > 200 ? 'line-clamp-4' : ''}`}>
                  {profile.personaPrompt}
                </pre>
              </div>
            )}

            {/* Model */}
            {profile?.model && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Model</label>
                <p className="text-sm text-[#d1d2d3] mt-1 font-mono">
                  {profile.model}
                </p>
              </div>
            )}

            {/* Working Directory */}
            {profile?.workingDirectory && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Working Directory</label>
                <p className="text-sm text-[#d1d2d3] mt-1 font-mono bg-[#2a2d31] p-2 rounded truncate" title={profile.workingDirectory}>
                  {profile.workingDirectory}
                </p>
              </div>
            )}

            {/* Agent ID */}
            {agent.agentId && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Agent ID</label>
                <p className="text-sm text-[#d1d2d3] mt-1 font-mono bg-[#2a2d31] p-2 rounded">
                  {agent.agentId}
                </p>
              </div>
            )}

            {/* Capabilities */}
            {profile?.capabilities && profile.capabilities.length > 0 && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Capabilities</label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {profile.capabilities.map((cap, i) => (
                    <span key={i} className="text-xs bg-[#2a2d31] text-[#d1d2d3] px-2 py-1 rounded">
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Last Seen */}
            {agent.lastSeen && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Last Seen</label>
                <p className="text-sm text-[#d1d2d3] mt-1">
                  {formatDateTime(agent.lastSeen)}
                </p>
              </div>
            )}

            {/* First Seen */}
            {profile?.firstSeen && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">First Seen</label>
                <p className="text-sm text-[#d1d2d3] mt-1">
                  {formatDateTime(profile.firstSeen)}
                </p>
              </div>
            )}

            {/* Message Count */}
            {agent.messageCount !== undefined && agent.messageCount > 0 && (
              <div>
                <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Messages</label>
                <p className="text-sm text-[#d1d2d3] mt-1">
                  {agent.messageCount} messages sent
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-white/10 space-y-2">
          {/* Message Button */}
          {onMessage && (
            <button
              onClick={() => {
                onMessage(agent);
                onClose();
              }}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#a855f7] hover:bg-[#9333ea] text-white font-medium rounded-lg transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Send Message
            </button>
          )}

          {/* Logs Button */}
          {agent.isSpawned && onLogs && (
            <button
              onClick={() => {
                onLogs(agent);
                onClose();
              }}
              className="w-full flex items-center justify-center gap-2 py-2.5 border border-[#00d9ff]/30 text-[#00d9ff] hover:bg-[#00d9ff]/10 font-medium rounded-lg transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              View Logs
            </button>
          )}

          {/* Release Button */}
          {agent.isSpawned && onRelease && (
            <button
              onClick={() => {
                if (confirm(`Are you sure you want to release ${displayName}?`)) {
                  onRelease(agent);
                  onClose();
                }
              }}
              className="w-full flex items-center justify-center gap-2 py-2.5 border border-[#ff6b6b]/30 text-[#ff6b6b] hover:bg-[#ff6b6b]/10 font-medium rounded-lg transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              Release Agent
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Format a timestamp to a readable date/time
 */
function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
