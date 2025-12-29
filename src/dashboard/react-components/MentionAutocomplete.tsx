/**
 * MentionAutocomplete Component
 *
 * Provides @-mention autocomplete for the message composer.
 * Shows a dropdown list of agents when typing @ at the start of a message.
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Agent } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface MentionAutocompleteProps {
  /** List of available agents */
  agents: Agent[];
  /** Current input value */
  inputValue: string;
  /** Cursor position in input */
  cursorPosition: number;
  /** Called when a mention is selected */
  onSelect: (mention: string, newValue: string) => void;
  /** Called when autocomplete should be hidden */
  onClose: () => void;
  /** Whether the autocomplete is visible */
  isVisible: boolean;
}

interface MentionOption {
  name: string;
  displayName: string;
  description: string;
  isBroadcast?: boolean;
}

/**
 * Check if the input has an @-mention being typed at the start
 */
export function getMentionQuery(value: string, cursorPos: number): string | null {
  // Check if cursor is within an @mention at the start
  const atMatch = value.match(/^@(\S*)/);
  if (atMatch && cursorPos <= atMatch[0].length) {
    return atMatch[1]; // Return the text after @
  }
  return null;
}

/**
 * Complete a mention in the input value
 */
export function completeMentionInValue(
  value: string,
  mention: string
): string {
  const atMatch = value.match(/^@\S*/);
  if (atMatch) {
    // Replace the @partial with @CompletedName
    const completedText = `@${mention} `;
    return completedText + value.substring(atMatch[0].length);
  }
  return value;
}

export function MentionAutocomplete({
  agents,
  inputValue,
  cursorPosition,
  onSelect,
  onClose,
  isVisible,
}: MentionAutocompleteProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Get the current mention query
  const query = useMemo(
    () => getMentionQuery(inputValue, cursorPosition),
    [inputValue, cursorPosition]
  );

  // Filter options based on query
  const options = useMemo((): MentionOption[] => {
    if (query === null) return [];

    const queryLower = query.toLowerCase();
    const result: MentionOption[] = [];

    // Add broadcast option if it matches
    const broadcastMatches =
      '*'.includes(queryLower) ||
      'everyone'.includes(queryLower) ||
      'all'.includes(queryLower) ||
      'broadcast'.includes(queryLower) ||
      queryLower === '';

    if (broadcastMatches) {
      result.push({
        name: '*',
        displayName: '@everyone',
        description: 'Broadcast to all agents',
        isBroadcast: true,
      });
    }

    // Filter agents by name
    const matchingAgents = agents.filter((agent) =>
      agent.name.toLowerCase().includes(queryLower)
    );

    matchingAgents.forEach((agent) => {
      result.push({
        name: agent.name,
        displayName: `@${agent.name}`,
        description: agent.status || 'Agent',
      });
    });

    return result;
  }, [query, agents]);

  // Reset selection when options change
  useEffect(() => {
    setSelectedIndex(0);
  }, [options.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('.mention-item.selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isVisible || options.length === 0) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % options.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
          break;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          const selected = options[selectedIndex];
          if (selected) {
            const newValue = completeMentionInValue(inputValue, selected.name);
            onSelect(selected.name, newValue);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [isVisible, options, selectedIndex, inputValue, onSelect, onClose]
  );

  // Register keyboard listener
  useEffect(() => {
    if (isVisible) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isVisible, handleKeyDown]);

  // Handle click on option
  const handleClick = useCallback(
    (option: MentionOption) => {
      const newValue = completeMentionInValue(inputValue, option.name);
      onSelect(option.name, newValue);
    },
    [inputValue, onSelect]
  );

  if (!isVisible || options.length === 0) {
    return null;
  }

  return (
    <div className="mention-autocomplete" ref={listRef}>
      {options.map((option, index) => (
        <div
          key={option.name}
          className={`mention-item ${index === selectedIndex ? 'selected' : ''}`}
          onClick={() => handleClick(option)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <div
            className="mention-avatar"
            style={{
              background: option.isBroadcast
                ? 'var(--accent-warning, #f59e0b)'
                : getAgentColor(option.name).primary,
            }}
          >
            {option.isBroadcast ? '*' : getAgentInitials(option.name)}
          </div>
          <div className="mention-info">
            <span className="mention-name">{option.displayName}</span>
            <span className="mention-description">{option.description}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Hook to manage mention autocomplete state
 */
export function useMentionAutocomplete(agents: Agent[]) {
  const [isVisible, setIsVisible] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);

  const handleInputChange = useCallback((value: string, cursorPos: number) => {
    setInputValue(value);
    setCursorPosition(cursorPos);

    // Show autocomplete if typing @mention at start
    const query = getMentionQuery(value, cursorPos);
    setIsVisible(query !== null);
  }, []);

  const handleSelect = useCallback((mention: string, newValue: string) => {
    setInputValue(newValue);
    setCursorPosition(newValue.indexOf(' ') + 1);
    setIsVisible(false);
  }, []);

  const handleClose = useCallback(() => {
    setIsVisible(false);
  }, []);

  return {
    isVisible,
    inputValue,
    cursorPosition,
    setInputValue: handleInputChange,
    handleSelect,
    handleClose,
  };
}

/**
 * CSS styles for mention autocomplete
 */
export const mentionAutocompleteStyles = `
.mention-autocomplete {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg-primary, #ffffff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.1);
  z-index: 100;
  margin-bottom: 4px;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.mention-item:hover,
.mention-item.selected {
  background: var(--bg-hover, #f3f4f6);
}

.mention-avatar {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 11px;
  font-weight: 600;
}

.mention-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mention-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #1f2937);
}

.mention-description {
  font-size: 12px;
  color: var(--text-muted, #6b7280);
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .mention-autocomplete {
    background: var(--bg-primary, #1f2937);
    border-color: var(--border-color, #374151);
  }

  .mention-item:hover,
  .mention-item.selected {
    background: var(--bg-hover, #374151);
  }

  .mention-name {
    color: var(--text-primary, #f9fafb);
  }

  .mention-description {
    color: var(--text-muted, #9ca3af);
  }
}
`;
