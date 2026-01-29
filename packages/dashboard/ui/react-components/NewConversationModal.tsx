/**
 * NewConversationModal Component
 *
 * Modal for starting a new conversation with an agent.
 * Allows selecting a target agent and composing an initial message.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Agent } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface NewConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (to: string, content: string) => Promise<boolean>;
  agents: Agent[];
  isSending?: boolean;
  error?: string | null;
  /** Optional: Pre-select an agent */
  preselectedAgent?: string;
}

export function NewConversationModal({
  isOpen,
  onClose,
  onSend,
  agents,
  isSending = false,
  error,
  preselectedAgent,
}: NewConversationModalProps) {
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter agents based on search query
  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents;
    const query = searchQuery.toLowerCase();
    return agents.filter(
      (agent) =>
        agent.name.toLowerCase().includes(query) ||
        agent.role?.toLowerCase().includes(query) ||
        agent.team?.toLowerCase().includes(query)
    );
  }, [agents, searchQuery]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedAgent(preselectedAgent || '');
      setMessage('');
      setSearchQuery('');
      setLocalError(null);
      setTimeout(() => {
        if (preselectedAgent) {
          messageInputRef.current?.focus();
        } else {
          searchInputRef.current?.focus();
        }
      }, 100);
    }
  }, [isOpen, preselectedAgent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedAgent) {
      setLocalError('Please select an agent');
      return;
    }

    if (!message.trim()) {
      setLocalError('Please enter a message');
      return;
    }

    setLocalError(null);
    const success = await onSend(selectedAgent, message.trim());

    if (success) {
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const handleAgentSelect = useCallback((agentName: string) => {
    setSelectedAgent(agentName);
    setLocalError(null);
    setTimeout(() => messageInputRef.current?.focus(), 50);
  }, []);

  if (!isOpen) return null;

  const displayError = error || localError;
  const selectedAgentData = agents.find((a) => a.name === selectedAgent);
  const selectedColors = selectedAgentData ? getAgentColor(selectedAgentData.name) : null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-bg-primary border border-border rounded-xl w-[520px] max-w-[90vw] max-h-[85vh] overflow-hidden shadow-modal animate-slide-up flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center">
              <MessageIcon />
            </div>
            <div>
              <h2 className="m-0 text-lg font-semibold text-text-primary">New Conversation</h2>
              <p className="m-0 text-xs text-text-muted">Start a direct message with an agent</p>
            </div>
          </div>
          <button
            className="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-md text-text-muted cursor-pointer transition-all duration-150 hover:bg-bg-hover hover:text-text-primary"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          {/* Agent Selection */}
          <div className="p-5 border-b border-border">
            <label className="block text-sm font-semibold text-text-primary mb-2">
              To
            </label>

            {selectedAgent ? (
              <div className="flex items-center gap-3 p-3 bg-bg-hover rounded-lg">
                <div
                  className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-sm font-semibold"
                  style={{ backgroundColor: selectedColors?.primary, color: selectedColors?.text }}
                >
                  {getAgentInitials(selectedAgent)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-text-primary">{selectedAgent}</div>
                  {selectedAgentData?.role && (
                    <div className="text-xs text-text-muted truncate">{selectedAgentData.role}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="flex items-center justify-center w-8 h-8 bg-bg-active border-none rounded-md text-text-muted cursor-pointer transition-all duration-150 hover:bg-bg-tertiary hover:text-text-primary"
                  onClick={() => {
                    setSelectedAgent('');
                    setTimeout(() => searchInputRef.current?.focus(), 50);
                  }}
                  aria-label="Change agent"
                >
                  <ChangeIcon />
                </button>
              </div>
            ) : (
              <>
                {/* Search Input */}
                <div className="relative mb-3">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                    <SearchIcon />
                  </div>
                  <input
                    ref={searchInputRef}
                    type="text"
                    className="w-full py-2.5 pl-10 pr-3.5 border border-border rounded-md text-sm font-sans outline-none bg-transparent text-text-primary transition-colors duration-150 focus:border-accent placeholder:text-text-muted"
                    placeholder="Search agents..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                {/* Agent List */}
                <div className="max-h-[200px] overflow-y-auto border border-border rounded-lg">
                  {filteredAgents.length === 0 ? (
                    <div className="p-4 text-center text-text-muted text-sm">
                      {searchQuery ? 'No agents found' : 'No agents available'}
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {/* Broadcast option */}
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 p-3 bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-bg-hover text-left"
                        onClick={() => handleAgentSelect('*')}
                      >
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-warning/20 flex items-center justify-center">
                          <BroadcastIcon />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-text-primary">Everyone</div>
                          <div className="text-xs text-text-muted">Broadcast to all agents</div>
                        </div>
                      </button>

                      {/* Agent options */}
                      {filteredAgents.map((agent) => {
                        const colors = getAgentColor(agent.name);
                        return (
                          <button
                            key={agent.name}
                            type="button"
                            className="w-full flex items-center gap-3 p-3 bg-transparent border-none cursor-pointer transition-colors duration-150 hover:bg-bg-hover text-left"
                            onClick={() => handleAgentSelect(agent.name)}
                          >
                            <div
                              className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold"
                              style={{ backgroundColor: colors.primary, color: colors.text }}
                            >
                              {getAgentInitials(agent.name)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-text-primary">{agent.name}</span>
                                <span
                                  className={`w-2 h-2 rounded-full ${
                                    agent.status === 'online' ? 'bg-success' : 'bg-text-muted'
                                  }`}
                                />
                              </div>
                              {(agent.role || agent.team) && (
                                <div className="text-xs text-text-muted truncate">
                                  {agent.role}
                                  {agent.role && agent.team && ' - '}
                                  {agent.team}
                                </div>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Message Input */}
          <div className="p-5 flex-1 overflow-hidden flex flex-col">
            <label className="block text-sm font-semibold text-text-primary mb-2" htmlFor="message">
              Message
            </label>
            <textarea
              ref={messageInputRef}
              id="message"
              className="flex-1 min-h-[120px] w-full py-3 px-3.5 border border-border rounded-md text-sm font-sans outline-none bg-transparent text-text-primary transition-colors duration-150 focus:border-accent resize-none placeholder:text-text-muted"
              placeholder={
                selectedAgent === '*'
                  ? 'Write a message to all agents...'
                  : selectedAgent
                  ? `Write a message to ${selectedAgent}...`
                  : 'Select an agent first...'
              }
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setLocalError(null);
              }}
              disabled={isSending || !selectedAgent}
            />
          </div>

          {/* Error Display */}
          {displayError && (
            <div className="flex items-center gap-2 mx-5 mb-4 p-3 bg-error/10 border border-error/30 rounded-md text-error text-sm">
              <ErrorIcon />
              <span>{displayError}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 p-5 pt-0 border-t border-border">
            <button
              type="button"
              className="flex items-center gap-1.5 py-2.5 px-4 border-none rounded-md text-sm font-medium cursor-pointer font-sans transition-all duration-150 bg-bg-hover text-text-secondary hover:bg-bg-active hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onClose}
              disabled={isSending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 py-2.5 px-4 border-none rounded-md text-sm font-medium cursor-pointer font-sans transition-all duration-150 bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSending || !selectedAgent || !message.trim()}
            >
              {isSending ? (
                <>
                  <Spinner />
                  Sending...
                </>
              ) : (
                <>
                  <SendIcon />
                  Send Message
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MessageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="9" y1="10" x2="15" y2="10" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
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

function ChangeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

function BroadcastIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-warning">
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24">
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
