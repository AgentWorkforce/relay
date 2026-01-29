/**
 * Dashboard V2 - History Page
 *
 * Full-page conversation history view with sessions, messages, and conversations.
 * Provides filtering, search, and navigation through historical data.
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  api,
  type HistorySession,
  type HistoryMessage,
  type Conversation,
  type HistoryStats,
} from '../../lib/api';
import { getAgentColor, getAgentInitials } from '../../lib/colors';

type ViewMode = 'conversations' | 'sessions' | 'messages';

export default function HistoryPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('conversations');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  // Fetch stats on mount
  useEffect(() => {
    const fetchStats = async () => {
      const result = await api.getHistoryStats();
      if (result.success && result.data) {
        setStats(result.data);
      }
    };
    fetchStats();
  }, []);

  // Fetch data based on view mode
  useEffect(() => {
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
            limit: 100,
          });
          if (result.success && result.data) {
            setSessions(result.data.sessions);
          } else {
            setError(result.error || 'Failed to fetch sessions');
          }
        } else if (viewMode === 'messages') {
          const params: Parameters<typeof api.getHistoryMessages>[0] = {
            limit: 200,
            order: 'desc',
          };

          if (searchQuery) {
            params.search = searchQuery;
          }

          if (selectedConversation) {
            const [p1, p2] = selectedConversation.participants;
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
  }, [viewMode, agentFilter, searchQuery, selectedConversation]);

  const handleConversationClick = useCallback((conv: Conversation) => {
    setSelectedConversation(conv);
    setViewMode('messages');
  }, []);

  const handleBackToConversations = useCallback(() => {
    setSelectedConversation(null);
    setViewMode('conversations');
  }, []);

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary font-sans">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-sidebar-bg border-b border-sidebar-border px-4 md:px-8 py-4">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="flex items-center gap-2 text-text-muted text-sm font-medium px-3 py-2 rounded-md transition-all hover:text-accent hover:bg-accent/10"
            >
              <BackIcon />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gradient-to-br from-accent/80 to-accent rounded-lg flex items-center justify-center border border-accent/30">
                <HistoryIcon />
              </div>
              <div className="text-lg font-semibold tracking-tight">
                Conversation <span className="text-accent">History</span>
              </div>
            </div>
          </div>

          {/* Stats */}
          {stats && (
            <div className="hidden md:flex items-center gap-4 text-sm">
              <StatBadge label="Messages" value={stats.messageCount} />
              <StatBadge label="Sessions" value={stats.sessionCount} />
              <StatBadge label="Agents" value={stats.uniqueAgents} />
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[1400px] mx-auto px-4 md:px-8 py-6">
        {/* Toolbar */}
        <div className="flex flex-col md:flex-row md:items-center gap-4 mb-6">
          {/* View mode tabs */}
          <div className="flex gap-1 bg-bg-secondary rounded-lg p-1 border border-border">
            <TabButton
              active={viewMode === 'conversations'}
              onClick={() => {
                setSelectedConversation(null);
                setViewMode('conversations');
              }}
            >
              <ConversationIcon />
              Conversations
            </TabButton>
            <TabButton
              active={viewMode === 'sessions'}
              onClick={() => setViewMode('sessions')}
            >
              <SessionIcon />
              Sessions
            </TabButton>
            <TabButton
              active={viewMode === 'messages'}
              onClick={() => setViewMode('messages')}
            >
              <MessageIcon />
              Messages
            </TabButton>
          </div>

          {/* Search/Filter */}
          <div className="flex-1 flex items-center gap-3">
            {viewMode === 'messages' && (
              <div className="flex-1 max-w-md">
                <div className="relative">
                  <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <input
                    type="text"
                    placeholder="Search messages..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
              </div>
            )}

            {viewMode === 'sessions' && (
              <div className="flex-1 max-w-md">
                <div className="relative">
                  <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <input
                    type="text"
                    placeholder="Filter by agent name..."
                    value={agentFilter}
                    onChange={(e) => setAgentFilter(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
              </div>
            )}

            {selectedConversation && (
              <button
                onClick={handleBackToConversations}
                className="flex items-center gap-2 px-4 py-2 text-sm text-text-muted hover:text-text-primary bg-bg-secondary border border-border rounded-lg transition-colors hover:bg-bg-tertiary"
              >
                <BackIcon />
                Back to conversations
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="flex items-center justify-center h-[60vh]">
            <div className="flex flex-col items-center gap-4">
              <div className="w-10 h-10 border-2 border-border border-t-accent rounded-full animate-spin" />
              <p className="text-text-muted text-sm">Loading history...</p>
            </div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-[60vh]">
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-error/10 flex items-center justify-center">
                <ErrorIcon />
              </div>
              <p className="text-text-secondary">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium transition-colors hover:bg-accent-hover"
              >
                Retry
              </button>
            </div>
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
      </main>
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
      className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
        active
          ? 'bg-accent text-white'
          : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary'
      }`}
    >
      {children}
    </button>
  );
}

function StatBadge({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-bg-secondary/50 border border-border/50 rounded-lg">
      <span className="text-text-muted text-xs">{label}:</span>
      <span className="text-accent font-mono font-semibold">{value}</span>
    </div>
  );
}

interface ConversationListProps {
  conversations: Conversation[];
  onConversationClick: (conv: Conversation) => void;
}

function ConversationList({ conversations, onConversationClick }: ConversationListProps) {
  if (conversations.length === 0) {
    return (
      <EmptyState
        icon={<ConversationIcon className="w-12 h-12" />}
        title="No conversations yet"
        description="Start messaging between agents to see conversation history here."
      />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {conversations.map((conv, index) => {
        const [agent1, agent2] = conv.participants;
        const colors1 = getAgentColor(agent1);
        const colors2 = getAgentColor(agent2);

        return (
          <div
            key={index}
            onClick={() => onConversationClick(conv)}
            className="p-5 bg-bg-secondary border border-border rounded-xl cursor-pointer transition-all hover:border-accent/50 hover:bg-bg-tertiary group"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="flex -space-x-2">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold border-2 border-bg-secondary"
                  style={{ backgroundColor: colors1.primary, color: colors1.text }}
                >
                  {getAgentInitials(agent1)}
                </div>
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold border-2 border-bg-secondary"
                  style={{ backgroundColor: colors2.primary, color: colors2.text }}
                >
                  {getAgentInitials(agent2)}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-text-primary truncate">
                  {agent1} & {agent2}
                </div>
                <div className="text-xs text-text-muted">
                  {conv.messageCount} messages
                </div>
              </div>
              <div className="text-xs text-text-muted">
                {formatRelativeTime(conv.lastTimestamp)}
              </div>
            </div>
            <p className="text-sm text-text-muted truncate">{conv.lastMessage}</p>
            <div className="mt-3 flex items-center gap-2 text-xs text-accent opacity-0 group-hover:opacity-100 transition-opacity">
              <span>View conversation</span>
              <ArrowRightIcon />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface SessionListProps {
  sessions: HistorySession[];
}

function SessionList({ sessions }: SessionListProps) {
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<SessionIcon className="w-12 h-12" />}
        title="No sessions found"
        description="Agent sessions will appear here when agents connect."
      />
    );
  }

  return (
    <div className="bg-bg-secondary border border-border rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="bg-bg-tertiary border-b border-border">
              <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Agent</th>
              <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Status</th>
              <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">CLI</th>
              <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Messages</th>
              <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Started</th>
              <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">Duration</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const colors = getAgentColor(session.agentName);
              return (
                <tr key={session.id} className="border-b border-border/50 last:border-0 transition-colors hover:bg-bg-hover">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-8 h-8 rounded-md flex items-center justify-center text-xs font-semibold"
                        style={{ backgroundColor: colors.primary, color: colors.text }}
                      >
                        {getAgentInitials(session.agentName)}
                      </div>
                      <span className="font-medium text-text-primary">{session.agentName}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <SessionStatusBadge isActive={session.isActive} closedBy={session.closedBy} />
                  </td>
                  <td className="py-3 px-4">
                    {session.cli && (
                      <span className="text-xs px-2 py-1 bg-bg-tertiary text-text-muted rounded font-mono">
                        {session.cli}
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono text-sm text-accent">{session.messageCount}</td>
                  <td className="py-3 px-4 text-sm text-text-muted">{formatDate(session.startedAt)}</td>
                  <td className="py-3 px-4 font-mono text-sm text-text-muted">{session.duration}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface SessionStatusBadgeProps {
  isActive: boolean;
  closedBy?: 'agent' | 'disconnect' | 'error';
}

function SessionStatusBadge({ isActive, closedBy }: SessionStatusBadgeProps) {
  if (isActive) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-success/15 text-success">
        <span className="w-1.5 h-1.5 bg-success rounded-full animate-pulse" />
        Active
      </span>
    );
  }

  const config = {
    agent: { label: 'Closed', className: 'bg-text-muted/10 text-text-muted' },
    disconnect: { label: 'Disconnected', className: 'bg-warning/15 text-warning' },
    error: { label: 'Error', className: 'bg-error/15 text-error' },
  };

  const style = closedBy ? config[closedBy] : config.agent;

  return (
    <span className={`inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full ${style.className}`}>
      {style.label}
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
      <EmptyState
        icon={<MessageIcon className="w-12 h-12" />}
        title="No messages found"
        description={conversationTitle ? "No messages in this conversation yet." : "Try adjusting your search or filters."}
      />
    );
  }

  return (
    <div className="space-y-4">
      {conversationTitle && (
        <h3 className="text-lg font-semibold text-text-primary mb-4">{conversationTitle}</h3>
      )}
      {messages.map((msg) => {
        const colors = getAgentColor(msg.from);
        return (
          <div
            key={msg.id}
            className="p-4 bg-bg-secondary border border-border rounded-xl transition-colors hover:border-border-dark"
          >
            <div className="flex items-start gap-3">
              <div
                className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold"
                style={{ backgroundColor: colors.primary, color: colors.text }}
              >
                {getAgentInitials(msg.from)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center flex-wrap gap-2 mb-2">
                  <span className="font-semibold text-accent">{msg.from}</span>
                  <span className="text-text-muted">to</span>
                  <span className="font-medium text-text-primary">
                    {msg.to === '*' ? 'Everyone' : msg.to}
                  </span>
                  {msg.isBroadcast && (
                    <span className="text-[10px] px-2 py-0.5 bg-warning/15 text-warning rounded-full font-medium">
                      Broadcast
                    </span>
                  )}
                  {msg.isUrgent && (
                    <span className="text-[10px] px-2 py-0.5 bg-error/15 text-error rounded-full font-medium">
                      Urgent
                    </span>
                  )}
                  {msg.thread && (
                    <span className="text-[10px] px-2 py-0.5 bg-accent/15 text-accent rounded-full font-medium">
                      {msg.thread}
                    </span>
                  )}
                  <span className="text-xs text-text-muted ml-auto">
                    {formatRelativeTime(msg.timestamp)}
                  </span>
                </div>
                <p className="text-sm text-text-primary whitespace-pre-wrap break-words">
                  {msg.content}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
}

function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="text-text-muted opacity-50 mb-4">{icon}</div>
      <h3 className="text-lg font-semibold text-text-primary mb-2">{title}</h3>
      <p className="text-sm text-text-muted max-w-md">{description}</p>
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

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M19 12H5M12 19l-7-7 7-7"/>
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function ConversationIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

function SessionIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="w-6 h-6 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="12" x2="19" y2="12"/>
      <polyline points="12 5 19 12 12 19"/>
    </svg>
  );
}
