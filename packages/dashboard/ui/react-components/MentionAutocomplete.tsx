/**
 * MentionAutocomplete Component
 *
 * Provides @-mention autocomplete for the message composer.
 * Shows a dropdown list of agents and teams when typing @ at the start of a message.
 * Supports:
 * - @AgentName - mention a specific agent
 * - @everyone / @* - broadcast to all agents
 * - @team:name - mention all agents in a team
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Agent } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

/** Human user info for autocomplete */
export interface HumanUser {
  /** Username (GitHub username) */
  username: string;
  /** Optional avatar URL */
  avatarUrl?: string;
}

export interface MentionAutocompleteProps {
  /** List of available agents */
  agents: Agent[];
  /** List of human users (extracted from recent messages) */
  humanUsers?: HumanUser[];
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
  isTeam?: boolean;
  isHuman?: boolean;
  avatarUrl?: string;
  memberCount?: number;
}

/**
 * Check if the input has an @-mention being typed at the cursor position.
 * Works for @ at any position in the text, not just the start.
 */
export function getMentionQuery(value: string, cursorPos: number): string | null {
  // Search backwards from cursor to find @
  const textBeforeCursor = value.substring(0, cursorPos);

  // Find the last @ before cursor that starts a mention
  // A mention starts after whitespace, at start of string, or after certain punctuation
  const mentionMatch = textBeforeCursor.match(/(?:^|[\s(])@(\S*)$/);
  if (mentionMatch) {
    return mentionMatch[1]; // Return the text after @
  }
  return null;
}

/**
 * Result of completing a mention.
 */
export interface CompletionResult {
  /** The new input value with the completed mention */
  value: string;
  /** The cursor position after the completion (after the trailing space) */
  cursorPosition: number;
}

/**
 * Complete a mention in the input value at the cursor position.
 */
export function completeMentionInValue(
  value: string,
  mention: string,
  cursorPos: number
): CompletionResult {
  const textBeforeCursor = value.substring(0, cursorPos);
  const textAfterCursor = value.substring(cursorPos);

  // Find the @ and partial text before cursor
  const mentionMatch = textBeforeCursor.match(/(?:^|[\s(])@(\S*)$/);
  if (mentionMatch) {
    // Calculate where the @ starts (accounting for whitespace/punctuation before it)
    const matchStart = mentionMatch.index || 0;
    const prefixChar = mentionMatch[0].charAt(0);
    const atStart = prefixChar === '@' ? matchStart : matchStart + 1;

    // Build the new value
    const beforeMention = value.substring(0, atStart);
    const completedMention = `@${mention} `;
    const newValue = beforeMention + completedMention + textAfterCursor;
    const newCursorPos = beforeMention.length + completedMention.length;
    return { value: newValue, cursorPosition: newCursorPos };
  }
  return { value, cursorPosition: cursorPos };
}

export function MentionAutocomplete({
  agents,
  humanUsers = [],
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

  // Extract unique teams from agents
  const teams = useMemo(() => {
    const teamMap = new Map<string, Agent[]>();
    agents.forEach((agent) => {
      if (agent.team) {
        const existing = teamMap.get(agent.team) || [];
        existing.push(agent);
        teamMap.set(agent.team, existing);
      }
    });
    return teamMap;
  }, [agents]);

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

    // Add team options if query matches "team" or a team name
    const isTeamQuery = queryLower.startsWith('team:') || queryLower.startsWith('team');
    const teamSearchQuery = queryLower.startsWith('team:')
      ? queryLower.substring(5)
      : queryLower.replace(/^team/, '');

    if (isTeamQuery || queryLower === '') {
      teams.forEach((members, teamName) => {
        const teamNameLower = teamName.toLowerCase();
        if (
          teamSearchQuery === '' ||
          teamNameLower.includes(teamSearchQuery) ||
          `team:${teamNameLower}`.includes(queryLower)
        ) {
          result.push({
            name: `team:${teamName}`,
            displayName: `@team:${teamName}`,
            description: `${members.length} agent${members.length !== 1 ? 's' : ''}: ${members.map(m => m.name).join(', ')}`,
            isTeam: true,
            memberCount: members.length,
          });
        }
      });
    }

    // Filter human users by username
    const agentNames = new Set(agents.map(a => a.name.toLowerCase()));
    const matchingHumans = humanUsers.filter((user) => {
      const usernameLower = user.username.toLowerCase();
      return usernameLower.includes(queryLower) &&
        !agentNames.has(usernameLower); // Don't show if they're also an agent name
    });

    matchingHumans.forEach((user) => {
      result.push({
        name: user.username,
        displayName: `@${user.username}`,
        description: 'Human user',
        isHuman: true,
        avatarUrl: user.avatarUrl,
      });
    });

    // Filter agents by name
    const matchingAgents = agents.filter((agent) =>
      agent.name.toLowerCase().includes(queryLower)
    );

    matchingAgents.forEach((agent) => {
      result.push({
        name: agent.name,
        displayName: `@${agent.name}`,
        description: agent.team ? `${agent.status || 'Agent'} · ${agent.team}` : (agent.status || 'Agent'),
      });
    });

    return result;
  }, [query, agents, humanUsers, teams]);

  // Reset selection when options change
  useEffect(() => {
    setSelectedIndex(0);
  }, [options.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
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
            const result = completeMentionInValue(inputValue, selected.name, cursorPosition);
            onSelect(selected.name, result.value);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [isVisible, options, selectedIndex, inputValue, cursorPosition, onSelect, onClose]
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
      const result = completeMentionInValue(inputValue, option.name, cursorPosition);
      onSelect(option.name, result.value);
    },
    [inputValue, cursorPosition, onSelect]
  );

  if (!isVisible || options.length === 0) {
    return null;
  }

  return (
    <div
      className="absolute bottom-full left-0 right-0 max-h-[200px] overflow-y-auto bg-[#1a1d21] border border-white/10 rounded-lg shadow-[0_-4px_20px_rgba(0,0,0,0.4)] z-[100] mb-1"
      ref={listRef}
    >
      {options.map((option, index) => (
        <div
          key={option.name}
          data-selected={index === selectedIndex}
          className={`flex items-center gap-2.5 py-2 px-3 cursor-pointer transition-colors duration-150 ${
            index === selectedIndex ? 'bg-white/[0.08]' : 'hover:bg-white/[0.08]'
          }`}
          onClick={() => handleClick(option)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          {/* Avatar/Icon */}
          {option.isHuman && option.avatarUrl ? (
            <img
              src={option.avatarUrl}
              alt={option.name}
              className="w-7 h-7 rounded-md object-cover"
            />
          ) : (
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center text-white text-[11px] font-semibold"
              style={{
                background: option.isBroadcast
                  ? 'var(--color-warning, #f59e0b)'
                  : option.isTeam
                  ? 'var(--color-accent-purple, #a855f7)'
                  : option.isHuman
                  ? '#a855f7' // Purple for human users
                  : getAgentColor(option.name).primary,
              }}
            >
              {option.isBroadcast ? '*' : option.isTeam ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              ) : option.isHuman ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              ) : getAgentInitials(option.name)}
            </div>
          )}
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <span className="text-sm font-medium text-[#d1d2d3]">{option.displayName}</span>
            <span className="text-xs text-[#8d8d8e] truncate">{option.description}</span>
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
