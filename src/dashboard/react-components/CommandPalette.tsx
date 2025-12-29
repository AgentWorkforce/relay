/**
 * CommandPalette Component
 *
 * A Slack/VS Code-style command palette with fuzzy search,
 * keyboard navigation, and categorized commands.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Agent } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface Command {
  id: string;
  label: string;
  description?: string;
  category: 'agents' | 'actions' | 'navigation' | 'settings';
  icon?: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  onAgentSelect: (agent: Agent) => void;
  onSpawnClick: () => void;
  onSettingsClick?: () => void;
  onGeneralClick?: () => void;
  customCommands?: Command[];
}

export function CommandPalette({
  isOpen,
  onClose,
  agents,
  onAgentSelect,
  onSpawnClick,
  onSettingsClick,
  onGeneralClick,
  customCommands = [],
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build command list
  const commands = useMemo(() => {
    const cmds: Command[] = [
      // Agent commands
      ...agents.map((agent) => ({
        id: `agent-${agent.name}`,
        label: agent.name,
        description: agent.currentTask || agent.status,
        category: 'agents' as const,
        icon: <AgentIcon name={agent.name} />,
        action: () => {
          onAgentSelect(agent);
          onClose();
        },
      })),
      // Action commands
      {
        id: 'spawn-agent',
        label: 'Spawn Agent',
        description: 'Launch a new agent instance',
        category: 'actions',
        icon: <PlusIcon />,
        shortcut: '⌘⇧S',
        action: () => {
          onSpawnClick();
          onClose();
        },
      },
      {
        id: 'broadcast',
        label: 'Broadcast Message',
        description: 'Send message to all agents',
        category: 'actions',
        icon: <BroadcastIcon />,
        action: () => {
          // Focus composer with broadcast target
          onClose();
        },
      },
      // Navigation commands
      {
        id: 'nav-general',
        label: 'Go to #general',
        description: 'View all broadcast messages',
        category: 'navigation',
        icon: <HashIcon />,
        action: () => {
          onGeneralClick?.();
          onClose();
        },
      },
      // Settings commands
      ...(onSettingsClick
        ? [
            {
              id: 'settings',
              label: 'Settings',
              description: 'Configure dashboard preferences',
              category: 'settings' as const,
              icon: <SettingsIcon />,
              shortcut: '⌘,',
              action: () => {
                onSettingsClick();
                onClose();
              },
            },
          ]
        : []),
      // Custom commands
      ...customCommands,
    ];
    return cmds;
  }, [agents, onAgentSelect, onSpawnClick, onSettingsClick, onGeneralClick, onClose, customCommands]);

  // Filter commands based on query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) return commands;

    const lowerQuery = query.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(lowerQuery) ||
        cmd.description?.toLowerCase().includes(lowerQuery) ||
        cmd.category.toLowerCase().includes(lowerQuery)
    );
  }, [commands, query]);

  // Group commands by category
  const groupedCommands = useMemo(() => {
    const groups: Record<string, Command[]> = {};
    for (const cmd of filteredCommands) {
      if (!groups[cmd.category]) {
        groups[cmd.category] = [];
      }
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filteredCommands]);

  // Flatten for keyboard navigation
  const flatCommands = useMemo(() => {
    const order = ['agents', 'actions', 'navigation', 'settings'];
    return order.flatMap((cat) => groupedCommands[cat] || []);
  }, [groupedCommands]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && flatCommands.length > 0) {
      const selectedEl = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      selectedEl?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, flatCommands.length]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, flatCommands.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatCommands[selectedIndex]) {
            flatCommands[selectedIndex].action();
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [flatCommands, selectedIndex, onClose]
  );

  if (!isOpen) return null;

  const categoryLabels: Record<string, string> = {
    agents: 'Agents',
    actions: 'Actions',
    navigation: 'Navigation',
    settings: 'Settings',
  };

  let globalIndex = 0;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input-wrapper">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Search commands, agents..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="command-palette-kbd">ESC</kbd>
        </div>

        <div className="command-palette-list" ref={listRef}>
          {flatCommands.length === 0 ? (
            <div className="command-palette-empty">
              No results for "{query}"
            </div>
          ) : (
            Object.entries(groupedCommands).map(([category, cmds]) => {
              if (!cmds.length) return null;
              return (
                <div key={category} className="command-palette-group">
                  <div className="command-palette-group-label">
                    {categoryLabels[category] || category}
                  </div>
                  {cmds.map((cmd) => {
                    const idx = globalIndex++;
                    return (
                      <button
                        key={cmd.id}
                        data-index={idx}
                        className={`command-palette-item ${idx === selectedIndex ? 'selected' : ''}`}
                        onClick={cmd.action}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <span className="command-palette-item-icon">{cmd.icon}</span>
                        <span className="command-palette-item-content">
                          <span className="command-palette-item-label">{cmd.label}</span>
                          {cmd.description && (
                            <span className="command-palette-item-desc">{cmd.description}</span>
                          )}
                        </span>
                        {cmd.shortcut && (
                          <kbd className="command-palette-item-shortcut">{cmd.shortcut}</kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// Icon components
function AgentIcon({ name }: { name: string }) {
  const colors = getAgentColor(name);
  return (
    <div
      className="command-palette-agent-icon"
      style={{ backgroundColor: colors.primary, color: colors.text }}
    >
      {getAgentInitials(name)}
    </div>
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

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function BroadcastIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
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
 * CSS styles for the command palette - Dark mode
 */
export const commandPaletteStyles = `
.command-palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  z-index: 1000;
  animation: fadeIn 0.15s ease;
}

.command-palette {
  background: #1a1a2e;
  border: 1px solid #2a2a3e;
  border-radius: 12px;
  width: 560px;
  max-width: 90vw;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 70px rgba(0, 0, 0, 0.5);
  animation: slideDown 0.2s ease;
}

.command-palette-input-wrapper {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid #2a2a3e;
}

.command-palette-input-wrapper svg {
  color: #888;
  flex-shrink: 0;
}

.command-palette-input {
  flex: 1;
  border: none;
  font-size: 16px;
  font-family: inherit;
  outline: none;
  background: transparent;
  color: #e8e8e8;
}

.command-palette-input::placeholder {
  color: #666;
}

.command-palette-kbd {
  background: #2a2a3e;
  border: 1px solid #3a3a4e;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  color: #888;
  font-family: inherit;
}

.command-palette-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.command-palette-empty {
  padding: 32px;
  text-align: center;
  color: #888;
  font-size: 14px;
}

.command-palette-group {
  margin-bottom: 8px;
}

.command-palette-group-label {
  font-size: 11px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 8px 12px 4px;
}

.command-palette-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: background 0.1s;
}

.command-palette-item:hover {
  background: #2a2a3e;
}

.command-palette-item.selected {
  background: rgba(74, 158, 255, 0.15);
  border: 1px solid rgba(74, 158, 255, 0.3);
}

.command-palette-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: #888;
}

.command-palette-agent-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
}

.command-palette-item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.command-palette-item-label {
  font-size: 14px;
  font-weight: 500;
  color: #e8e8e8;
}

.command-palette-item-desc {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.command-palette-item-shortcut {
  background: #2a2a3e;
  border: 1px solid #3a3a4e;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  color: #888;
  font-family: inherit;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`;
