/**
 * Conversation History Viewer
 *
 * Displays historical conversations from the database with:
 * - Session list with filtering
 * - Conversation view grouped by agent pairs
 * - Message search
 * - Storage statistics
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  api,
  type HistorySession,
  type HistoryMessage,
  type Conversation,
  type HistoryStats,
} from '../lib/api';

type ViewMode = 'conversations' | 'sessions' | 'messages';

interface ConversationHistoryProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ConversationHistory({ isOpen, onClose }: ConversationHistoryProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('conversations');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  // Fetch stats on mount
  useEffect(() => {
    if (!isOpen) return;

    const fetchStats = async () => {
      const result = await api.getHistoryStats();
      if (result.success && result.data) {
        setStats(result.data);
      }
    };
    fetchStats();
  }, [isOpen]);

  // Fetch data based on view mode
  useEffect(() => {
    if (!isOpen) return;

    const fetchData = async () => {
      setIsLoading(true);
      setError(null);

      try {
        if (viewMode === 'conversations') {
          const result = await api.getHistoryConversations();
          if (result.success && result.data) {
            setConversations(result.data.conversations);
          } else {
            setError(result.error || 'Failed to fetch conversations');
          }
        } else if (viewMode === 'sessions') {
          const result = await api.getHistorySessions({
            agent: agentFilter || undefined,
            limit: 50,
          });
          if (result.success && result.data) {
            setSessions(result.data.sessions);
          } else {
            setError(result.error || 'Failed to fetch sessions');
          }
        } else if (viewMode === 'messages') {
          const params: Parameters<typeof api.getHistoryMessages>[0] = {
            limit: 100,
            order: 'desc',
          };

          if (searchQuery) {
            params.search = searchQuery;
          }

          if (selectedConversation) {
            // Get messages between the two participants
            const [p1, p2] = selectedConversation.participants;
            // We need to fetch messages in both directions
            const result1 = await api.getHistoryMessages({ ...params, from: p1, to: p2 });
            const result2 = await api.getHistoryMessages({ ...params, from: p2, to: p1 });

            if (result1.success && result2.success) {
              const allMessages = [
                ...(result1.data?.messages || []),
                ...(result2.data?.messages || []),
              ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
              setMessages(allMessages);
            }
          } else {
            const result = await api.getHistoryMessages(params);
            if (result.success && result.data) {
              setMessages(result.data.messages);
            } else {
              setError(result.error || 'Failed to fetch messages');
            }
          }
        }
      } catch (_err) {
        setError('Failed to load data');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [isOpen, viewMode, agentFilter, searchQuery, selectedConversation]);

  // Handle conversation click - show messages for that conversation
  const handleConversationClick = useCallback((conv: Conversation) => {
    setSelectedConversation(conv);
    setViewMode('messages');
  }, []);

  // Handle back from conversation messages
  const handleBackToConversations = useCallback(() => {
    setSelectedConversation(null);
    setViewMode('conversations');
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50">
      <div className="bg-bg-primary rounded-lg shadow-xl w-[90vw] max-w-4xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-text-primary">Conversation History</h2>
            {stats && (
              <div className="flex gap-4 text-sm text-text-muted">
                <span>{stats.messageCount} messages</span>
                <span>{stats.sessionCount} sessions</span>
                <span>{stats.uniqueAgents} agents</span>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text-primary rounded transition-colors"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-4 p-4 border-b border-border">
          {/* View mode tabs */}
          <div className="flex gap-1 bg-bg-secondary rounded-md p-1">
            <TabButton
              active={viewMode === 'conversations'}
              onClick={() => {
                setSelectedConversation(null);
                setViewMode('conversations');
              }}
            >
              Conversations
            </TabButton>
            <TabButton
              active={viewMode === 'sessions'}
              onClick={() => setViewMode('sessions')}
            >
              Sessions
            </TabButton>
            <TabButton
              active={viewMode === 'messages'}
              onClick={() => setViewMode('messages')}
            >
              Messages
            </TabButton>
          </div>

          {/* Search */}
          {viewMode === 'messages' && (
            <div className="flex-1 max-w-xs">
              <input
                type="text"
                placeholder="Search messages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
            </div>
          )}

          {/* Agent filter for sessions */}
          {viewMode === 'sessions' && (
            <div className="flex-1 max-w-xs">
              <input
                type="text"
                placeholder="Filter by agent..."
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}
                className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-md text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
              />
            </div>
          )}

          {/* Back button when viewing conversation messages */}
          {selectedConversation && (
            <button
              onClick={handleBackToConversations}
              className="flex items-center gap-1 px-3 py-2 text-sm text-text-muted hover:text-text-primary"
            >
              <BackIcon /> Back to conversations
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <LoadingSpinner />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full text-error">
              {error}
            </div>
          ) : viewMode === 'conversations' ? (
            <ConversationList
              conversations={conversations}
              onConversationClick={handleConversationClick}
            />
          ) : viewMode === 'sessions' ? (
            <SessionList sessions={sessions} />
          ) : (
            <MessageHistoryList
              messages={messages}
              conversationTitle={
                selectedConversation
                  ? `${selectedConversation.participants[0]} & ${selectedConversation.participants[1]}`
                  : undefined
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Sub-components

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded transition-colors ${
        active
          ? 'bg-accent text-white'
          : 'text-text-muted hover:text-text-primary hover:bg-bg-primary'
      }`}
    >
      {children}
    </button>
  );
}

interface ConversationListProps {
  conversations: Conversation[];
  onConversationClick: (conv: Conversation) => void;
}

function ConversationList({ conversations, onConversationClick }: ConversationListProps) {
  if (conversations.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        No conversations found
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {conversations.map((conv, index) => (
        <div
          key={index}
          onClick={() => onConversationClick(conv)}
          className="p-4 bg-bg-secondary rounded-lg cursor-pointer hover:bg-bg-tertiary transition-colors"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-primary">
                {conv.participants.join(' & ')}
              </span>
              <span className="text-xs px-2 py-0.5 bg-accent/10 text-accent rounded-full">
                {conv.messageCount} messages
              </span>
            </div>
            <span className="text-xs text-text-muted">
              {formatRelativeTime(conv.lastTimestamp)}
            </span>
          </div>
          <p className="text-sm text-text-muted truncate">{conv.lastMessage}</p>
        </div>
      ))}
    </div>
  );
}

interface SessionListProps {
  sessions: HistorySession[];
}

function SessionList({ sessions }: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        No sessions found
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sessions.map((session) => (
        <div
          key={session.id}
          className="p-4 bg-bg-secondary rounded-lg"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-primary">{session.agentName}</span>
              {session.cli && (
                <span className="text-xs px-2 py-0.5 bg-bg-tertiary text-text-muted rounded">
                  {session.cli}
                </span>
              )}
              <StatusBadge isActive={session.isActive} closedBy={session.closedBy} />
            </div>
            <span className="text-xs text-text-muted">{session.duration}</span>
          </div>
          <div className="flex items-center gap-4 text-sm text-text-muted">
            <span>{formatDate(session.startedAt)}</span>
            <span>{session.messageCount} messages</span>
          </div>
          {session.summary && (
            <p className="mt-2 text-sm text-text-muted truncate">{session.summary}</p>
          )}
        </div>
      ))}
    </div>
  );
}

interface StatusBadgeProps {
  isActive: boolean;
  closedBy?: 'agent' | 'disconnect' | 'error';
}

function StatusBadge({ isActive, closedBy }: StatusBadgeProps) {
  if (isActive) {
    return (
      <span className="text-xs px-2 py-0.5 bg-success/10 text-success rounded-full">
        Active
      </span>
    );
  }

  const statusColors = {
    agent: 'bg-text-muted/10 text-text-muted',
    disconnect: 'bg-warning/10 text-warning',
    error: 'bg-error/10 text-error',
  };

  const statusText = {
    agent: 'Closed',
    disconnect: 'Disconnected',
    error: 'Error',
  };

  const color = closedBy ? statusColors[closedBy] : statusColors.agent;
  const text = closedBy ? statusText[closedBy] : 'Ended';

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${color}`}>
      {text}
    </span>
  );
}

interface MessageHistoryListProps {
  messages: HistoryMessage[];
  conversationTitle?: string;
}

function MessageHistoryList({ messages, conversationTitle }: MessageHistoryListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        No messages found
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {conversationTitle && (
        <h3 className="text-lg font-medium text-text-primary mb-4">{conversationTitle}</h3>
      )}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className="p-4 bg-bg-secondary rounded-lg"
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-accent">{msg.from}</span>
              <span className="text-text-muted">to</span>
              <span className="font-medium text-text-primary">
                {msg.to === '*' ? 'Everyone' : msg.to}
              </span>
              {msg.isBroadcast && (
                <span className="text-xs px-2 py-0.5 bg-accent/10 text-accent rounded-full">
                  Broadcast
                </span>
              )}
              {msg.isUrgent && (
                <span className="text-xs px-2 py-0.5 bg-error/10 text-error rounded-full">
                  Urgent
                </span>
              )}
            </div>
            <span className="text-xs text-text-muted">
              {formatRelativeTime(msg.timestamp)}
            </span>
          </div>
          <p className="text-sm text-text-primary whitespace-pre-wrap">{msg.content}</p>
          {msg.thread && (
            <div className="mt-2 text-xs text-text-muted">
              Thread: {msg.thread.slice(0, 8)}...
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Utility functions

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

// Icons

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin text-accent" width="24" height="24" viewBox="0 0 24 24">
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
