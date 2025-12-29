/**
 * Header Component
 *
 * Top navigation bar with current context, quick actions,
 * and command palette trigger.
 */

import React from 'react';
import type { Agent } from '../../types';
import { getAgentColor, getAgentInitials } from '../../lib/colors';
import { getAgentBreadcrumb } from '../../lib/hierarchy';

export interface HeaderProps {
  currentChannel: string;
  selectedAgent?: Agent | null;
  onCommandPaletteOpen?: () => void;
  onSettingsClick?: () => void;
}

export function Header({
  currentChannel,
  selectedAgent,
  onCommandPaletteOpen,
  onSettingsClick,
}: HeaderProps) {
  const isGeneral = currentChannel === 'general';
  const colors = selectedAgent ? getAgentColor(selectedAgent.name) : null;

  return (
    <header className="header">
      <div className="header-left">
        {isGeneral ? (
          <>
            <span className="channel-prefix">#</span>
            <span className="channel-name">general</span>
            <span className="channel-topic">All agent communications</span>
          </>
        ) : selectedAgent ? (
          <>
            <div
              className="agent-avatar-small"
              style={{ backgroundColor: colors?.primary }}
            >
              <span style={{ color: colors?.text }}>
                {getAgentInitials(selectedAgent.name)}
              </span>
            </div>
            <div className="channel-info">
              <span className="channel-name">{selectedAgent.name}</span>
              <span className="channel-breadcrumb">
                {getAgentBreadcrumb(selectedAgent.name)}
              </span>
            </div>
            {selectedAgent.status && (
              <span className="agent-status-badge">{selectedAgent.status}</span>
            )}
          </>
        ) : (
          <>
            <span className="channel-prefix">@</span>
            <span className="channel-name">{currentChannel}</span>
          </>
        )}
      </div>

      <div className="header-right">
        <button
          className="header-btn command-palette-btn"
          onClick={onCommandPaletteOpen}
          title="Command Palette (⌘K)"
        >
          <SearchIcon />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>

        <button
          className="header-btn icon-btn"
          onClick={onSettingsClick}
          title="Settings"
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * CSS styles for the header
 */
export const headerStyles = `
.header {
  height: 52px;
  background: #ffffff;
  border-bottom: 1px solid #e8e8e8;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-prefix {
  color: #888;
  font-size: 16px;
}

.channel-name {
  font-weight: 600;
  font-size: 15px;
  color: #1a1a1a;
}

.channel-topic,
.channel-breadcrumb {
  color: #888;
  font-size: 13px;
  margin-left: 8px;
  padding-left: 8px;
  border-left: 1px solid #e8e8e8;
}

.channel-info {
  display: flex;
  flex-direction: column;
}

.channel-info .channel-breadcrumb {
  margin-left: 0;
  padding-left: 0;
  border-left: none;
  font-size: 11px;
}

.agent-avatar-small {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 11px;
}

.agent-status-badge {
  background: #f0f0f0;
  color: #666;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 8px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: #f5f5f5;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  color: #666;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.header-btn:hover {
  background: #ebebeb;
  color: #333;
}

.header-btn kbd {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
  color: #888;
}

.icon-btn {
  padding: 6px;
}

.icon-btn svg {
  display: block;
}
`;
