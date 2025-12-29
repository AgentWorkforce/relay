/**
 * Sidebar Component
 *
 * Main navigation sidebar with agent list, view mode toggle,
 * and quick actions.
 */

import React, { useState } from 'react';
import type { Agent } from '../../types';
import { AgentList } from '../AgentList';

export interface SidebarProps {
  agents: Agent[];
  selectedAgent?: string;
  viewMode: 'local' | 'fleet';
  isFleetAvailable: boolean;
  isConnected: boolean;
  onAgentSelect?: (agent: Agent) => void;
  onViewModeChange?: (mode: 'local' | 'fleet') => void;
  onSpawnClick?: () => void;
  onReleaseClick?: (agent: Agent) => void;
}

export function Sidebar({
  agents,
  selectedAgent,
  viewMode,
  isFleetAvailable,
  isConnected,
  onAgentSelect,
  onViewModeChange,
  onSpawnClick,
  onReleaseClick,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <aside className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-title">
          <h1>Agent Relay</h1>
          <ConnectionIndicator isConnected={isConnected} />
        </div>

        {/* View Mode Toggle */}
        {isFleetAvailable && (
          <div className="view-mode-toggle">
            <button
              className={`toggle-btn ${viewMode === 'local' ? 'active' : ''}`}
              onClick={() => onViewModeChange?.('local')}
            >
              Local
            </button>
            <button
              className={`toggle-btn ${viewMode === 'fleet' ? 'active' : ''}`}
              onClick={() => onViewModeChange?.('fleet')}
            >
              Fleet
            </button>
          </div>
        )}
      </div>

      {/* Search */}
      <div className="sidebar-search">
        <SearchIcon />
        <input
          type="text"
          placeholder="Search agents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="clear-btn" onClick={() => setSearchQuery('')}>
            <ClearIcon />
          </button>
        )}
      </div>

      {/* Agent List */}
      <div className="sidebar-content">
        <AgentList
          agents={agents}
          selectedAgent={selectedAgent}
          searchQuery={searchQuery}
          onAgentSelect={onAgentSelect}
          onReleaseClick={onReleaseClick}
          compact={true}
          showGroupStats={true}
        />
      </div>

      {/* Footer Actions */}
      <div className="sidebar-footer">
        <a href="/metrics" className="nav-link metrics-link">
          <MetricsIcon />
          <span>Metrics</span>
        </a>
        <button className="spawn-btn" onClick={onSpawnClick}>
          <PlusIcon />
          Spawn Agent
        </button>
      </div>
    </aside>
  );
}

function ConnectionIndicator({ isConnected }: { isConnected: boolean }) {
  return (
    <div
      className={`connection-indicator ${isConnected ? 'connected' : 'disconnected'}`}
      title={isConnected ? 'Connected' : 'Disconnected'}
    />
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function MetricsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </svg>
  );
}

/**
 * CSS styles for the sidebar
 */
export const sidebarStyles = `
.sidebar {
  width: 280px;
  height: 100vh;
  background: #1a1a2e;
  color: #e8e8e8;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #2a2a3e;
}

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid #2a2a3e;
}

.sidebar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.sidebar-title h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.connection-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.connection-indicator.connected {
  background: #22c55e;
}

.connection-indicator.disconnected {
  background: #6b7280;
}

.view-mode-toggle {
  display: flex;
  background: #2a2a3e;
  border-radius: 6px;
  padding: 2px;
}

.toggle-btn {
  flex: 1;
  padding: 6px 12px;
  background: transparent;
  border: none;
  color: #888;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
}

.toggle-btn.active {
  background: #3a3a4e;
  color: #fff;
}

.sidebar-search {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #2a2a3e;
  margin: 12px;
  border-radius: 6px;
}

.sidebar-search input {
  flex: 1;
  background: transparent;
  border: none;
  color: #e8e8e8;
  font-size: 13px;
  outline: none;
}

.sidebar-search input::placeholder {
  color: #666;
}

.sidebar-search svg {
  color: #666;
}

.clear-btn {
  background: transparent;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clear-btn:hover {
  color: #999;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.sidebar-footer {
  padding: 16px;
  border-top: 1px solid #2a2a3e;
}

.spawn-btn {
  width: 100%;
  padding: 10px 16px;
  background: #3a3a4e;
  border: 1px solid #4a4a5e;
  border-radius: 6px;
  color: #e8e8e8;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.2s;
}

.spawn-btn:hover {
  background: #4a4a5e;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 8px;
  background: linear-gradient(135deg, #2a2a3e 0%, #1e1e2e 100%);
  border: 1px solid #3a3a4e;
  border-radius: 8px;
  color: #e8e8e8;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  transition: all 0.2s ease;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.nav-link:hover {
  background: linear-gradient(135deg, #3a3a4e 0%, #2a2a3e 100%);
  border-color: #00ffc8;
  color: #00ffc8;
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 255, 200, 0.15);
}

.nav-link svg {
  opacity: 0.8;
  flex-shrink: 0;
}

.nav-link:hover svg {
  opacity: 1;
}

.nav-link.metrics-link {
  background: linear-gradient(135deg, #1e3a5f 0%, #1a2a3e 100%);
  border-color: #2a4a6e;
}

.nav-link.metrics-link:hover {
  background: linear-gradient(135deg, #2a4a6e 0%, #1e3a5f 100%);
  border-color: #4a9eff;
  color: #4a9eff;
  box-shadow: 0 4px 8px rgba(74, 158, 255, 0.15);
}
`;
