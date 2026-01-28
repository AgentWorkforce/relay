/**
 * BroadcastComposer Component
 *
 * Enhanced message composer for fleet-wide broadcasts,
 * with server/agent targeting and message templates.
 */

import React, { useState, useCallback, useMemo } from 'react';
import type { Agent } from '../types';
import type { ServerInfo } from './ServerCard';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface BroadcastTarget {
  type: 'all' | 'server' | 'agents';
  serverIds?: string[];
  agentNames?: string[];
}

export interface BroadcastComposerProps {
  servers: ServerInfo[];
  agents: Agent[];
  onSend: (message: string, target: BroadcastTarget) => Promise<boolean>;
  isSending?: boolean;
  error?: string | null;
}

const MESSAGE_TEMPLATES = [
  { id: 'status', label: 'Status Request', message: 'STATUS: Please report your current status and progress.' },
  { id: 'sync', label: 'Sync Check', message: 'SYNC: Checking in - please acknowledge receipt.' },
  { id: 'halt', label: 'Halt Work', message: 'HALT: Please pause current work and await further instructions.' },
  { id: 'resume', label: 'Resume Work', message: 'RESUME: You may continue with your assigned tasks.' },
];

export function BroadcastComposer({
  servers,
  agents,
  onSend,
  isSending = false,
  error,
}: BroadcastComposerProps) {
  const [message, setMessage] = useState('');
  const [targetType, setTargetType] = useState<'all' | 'server' | 'agents'>('all');
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [showTemplates, setShowTemplates] = useState(false);

  // Online servers only
  const onlineServers = useMemo(
    () => servers.filter((s) => s.status === 'online'),
    [servers]
  );

  // Build target description
  const targetDescription = useMemo(() => {
    if (targetType === 'all') {
      return `All ${agents.length} agents across ${onlineServers.length} servers`;
    }
    if (targetType === 'server') {
      const count = selectedServers.size;
      return count === 0
        ? 'Select servers'
        : `${count} server${count > 1 ? 's' : ''} selected`;
    }
    if (targetType === 'agents') {
      const count = selectedAgents.size;
      return count === 0
        ? 'Select agents'
        : `${count} agent${count > 1 ? 's' : ''} selected`;
    }
    return '';
  }, [targetType, selectedServers, selectedAgents, agents.length, onlineServers.length]);

  // Handle send
  const handleSend = useCallback(async () => {
    if (!message.trim() || isSending) return;

    const target: BroadcastTarget = {
      type: targetType,
      serverIds: targetType === 'server' ? Array.from(selectedServers) : undefined,
      agentNames: targetType === 'agents' ? Array.from(selectedAgents) : undefined,
    };

    const success = await onSend(message, target);
    if (success) {
      setMessage('');
    }
  }, [message, targetType, selectedServers, selectedAgents, onSend, isSending]);

  // Toggle server selection
  const toggleServer = (serverId: string) => {
    setSelectedServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    });
  };

  // Toggle agent selection
  const toggleAgent = (agentName: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentName)) {
        next.delete(agentName);
      } else {
        next.add(agentName);
      }
      return next;
    });
  };

  // Apply template
  const applyTemplate = (template: (typeof MESSAGE_TEMPLATES)[0]) => {
    setMessage(template.message);
    setShowTemplates(false);
  };

  return (
    <div className="broadcast-composer">
      <div className="broadcast-header">
        <BroadcastIcon />
        <span className="broadcast-title">Fleet Broadcast</span>
        <span className="broadcast-target">{targetDescription}</span>
      </div>

      {/* Target Type Selection */}
      <div className="broadcast-target-types">
        <button
          className={`broadcast-target-btn ${targetType === 'all' ? 'active' : ''}`}
          onClick={() => setTargetType('all')}
        >
          <GlobeIcon />
          All
        </button>
        <button
          className={`broadcast-target-btn ${targetType === 'server' ? 'active' : ''}`}
          onClick={() => setTargetType('server')}
        >
          <ServerIcon />
          By Server
        </button>
        <button
          className={`broadcast-target-btn ${targetType === 'agents' ? 'active' : ''}`}
          onClick={() => setTargetType('agents')}
        >
          <UsersIcon />
          By Agent
        </button>
      </div>

      {/* Server Selection */}
      {targetType === 'server' && (
        <div className="broadcast-selection">
          <div className="broadcast-selection-label">Select servers:</div>
          <div className="broadcast-selection-items">
            {onlineServers.map((server) => (
              <button
                key={server.id}
                className={`broadcast-selection-item ${
                  selectedServers.has(server.id) ? 'selected' : ''
                }`}
                onClick={() => toggleServer(server.id)}
              >
                <span className="broadcast-item-dot" />
                <span>{server.name}</span>
                <span className="broadcast-item-count">{server.agentCount}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Agent Selection */}
      {targetType === 'agents' && (
        <div className="broadcast-selection">
          <div className="broadcast-selection-label">Select agents:</div>
          <div className="broadcast-selection-items broadcast-selection-agents">
            {agents.map((agent) => {
              const colors = getAgentColor(agent.name);
              return (
                <button
                  key={agent.name}
                  className={`broadcast-selection-item ${
                    selectedAgents.has(agent.name) ? 'selected' : ''
                  }`}
                  onClick={() => toggleAgent(agent.name)}
                >
                  <div
                    className="broadcast-agent-avatar"
                    style={{ backgroundColor: colors.primary, color: colors.text }}
                  >
                    {getAgentInitials(agent.name)}
                  </div>
                  <span>{agent.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Message Input */}
      <div className="broadcast-input-wrapper">
        <textarea
          className="broadcast-input"
          placeholder="Type your broadcast message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={isSending}
          rows={3}
        />

        <div className="broadcast-input-actions">
          <div className="broadcast-templates-wrapper">
            <button
              className="broadcast-template-btn"
              onClick={() => setShowTemplates(!showTemplates)}
            >
              <TemplateIcon />
              <span className="broadcast-template-text">Templates</span>
            </button>
            {showTemplates && (
              <div className="broadcast-templates-menu">
                {MESSAGE_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    className="broadcast-template-item"
                    onClick={() => applyTemplate(template)}
                  >
                    <span className="broadcast-template-label">{template.label}</span>
                    <span className="broadcast-template-preview">{template.message}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className="broadcast-send-btn"
            onClick={handleSend}
            disabled={!message.trim() || isSending || (targetType !== 'all' &&
              (targetType === 'server' ? selectedServers.size === 0 : selectedAgents.size === 0))}
          >
            {isSending ? <Spinner /> : <SendIcon />}
            <span className="broadcast-send-text">{isSending ? 'Sending...' : 'Broadcast'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="broadcast-error">
          <ErrorIcon />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// Icon components
function BroadcastIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function TemplateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="broadcast-spinner" width="14" height="14" viewBox="0 0 24 24">
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
 * CSS styles for the broadcast composer
 */
export const broadcastComposerStyles = `
.broadcast-composer {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
  overflow: hidden;
}

.broadcast-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #e8e8e8;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #ffffff;
}

.broadcast-header svg {
  opacity: 0.9;
}

.broadcast-title {
  font-weight: 600;
  font-size: 14px;
}

.broadcast-target {
  margin-left: auto;
  font-size: 12px;
  opacity: 0.9;
}

.broadcast-target-types {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
}

.broadcast-target-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: #ffffff;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.broadcast-target-btn:hover {
  border-color: #d0d0d0;
  color: #333;
}

.broadcast-target-btn.active {
  background: #1264a3;
  border-color: #1264a3;
  color: #ffffff;
}

.broadcast-selection {
  padding: 12px 16px;
  border-bottom: 1px solid #e8e8e8;
}

.broadcast-selection-label {
  font-size: 12px;
  font-weight: 500;
  color: #666;
  margin-bottom: 8px;
}

.broadcast-selection-items {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.broadcast-selection-agents {
  max-height: 120px;
  overflow-y: auto;
}

.broadcast-selection-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 12px;
  color: #333;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.broadcast-selection-item:hover {
  background: #f0f0f0;
}

.broadcast-selection-item.selected {
  background: #e8f4fd;
  border-color: #1264a3;
  color: #1264a3;
}

.broadcast-item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
}

.broadcast-item-count {
  font-size: 11px;
  color: #888;
  background: #f0f0f0;
  padding: 1px 5px;
  border-radius: 8px;
}

.broadcast-agent-avatar {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  font-weight: 600;
}

.broadcast-input-wrapper {
  padding: 16px;
}

.broadcast-input {
  width: 100%;
  padding: 12px;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
  min-height: 80px;
  outline: none;
  transition: border-color 0.15s;
}

.broadcast-input:focus {
  border-color: #1264a3;
}

.broadcast-input:disabled {
  background: #fafafa;
  color: #888;
}

.broadcast-input-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.broadcast-templates-wrapper {
  position: relative;
}

.broadcast-template-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.broadcast-template-btn:hover {
  background: #f0f0f0;
  color: #333;
}

.broadcast-templates-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  width: 300px;
  margin-bottom: 4px;
  background: #ffffff;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  z-index: 10;
}

.broadcast-template-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  transition: background 0.15s;
}

.broadcast-template-item:last-child {
  border-bottom: none;
}

.broadcast-template-item:hover {
  background: #f9f9f9;
}

.broadcast-template-label {
  font-size: 13px;
  font-weight: 500;
  color: #333;
}

.broadcast-template-preview {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.broadcast-send-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: #ffffff;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.broadcast-send-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
}

.broadcast-send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.broadcast-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.broadcast-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #fef2f2;
  border-top: 1px solid #fecaca;
  color: #dc2626;
  font-size: 13px;
}

/* Responsive styles */
@media (max-width: 768px) {
  .broadcast-input-actions {
    gap: 8px;
  }

  .broadcast-send-btn {
    padding: 8px 12px;
    font-size: 12px;
  }

  .broadcast-template-btn {
    padding: 6px 10px;
  }
}

@media (max-width: 480px) {
  .broadcast-input-wrapper {
    padding: 12px;
  }

  .broadcast-send-btn {
    padding: 8px;
    min-width: auto;
  }

  .broadcast-send-text {
    display: none;
  }

  .broadcast-template-text {
    display: none;
  }

  .broadcast-template-btn {
    padding: 8px;
  }
}
`;
