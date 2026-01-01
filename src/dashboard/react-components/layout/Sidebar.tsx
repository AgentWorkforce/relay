/**
 * Sidebar Component - Mission Control Theme
 *
 * Main navigation sidebar with project/agent list, view mode toggle,
 * and quick actions. Redesigned to match landing page aesthetic.
 */

import React, { useState, useEffect } from 'react';
import type { Agent, Project } from '../../types';
import type { ThreadInfo } from '../hooks/useMessages';
import { AgentList } from '../AgentList';
import { ProjectList } from '../ProjectList';
import { ThreadList } from '../ThreadList';
import { LogoIcon } from '../Logo';

const THREADS_COLLAPSED_KEY = 'agent-relay-threads-collapsed';

export interface SidebarProps {
  agents: Agent[];
  projects?: Project[];
  currentProject?: string;
  selectedAgent?: string;
  viewMode: 'local' | 'fleet';
  isFleetAvailable: boolean;
  isConnected: boolean;
  /** Mobile: whether sidebar is open */
  isOpen?: boolean;
  /** Active threads for the threads section */
  activeThreads?: ThreadInfo[];
  /** Currently selected thread */
  currentThread?: string | null;
  /** Total unread thread count for notification badge */
  totalUnreadThreadCount?: number;
  onAgentSelect?: (agent: Agent, project?: Project) => void;
  onProjectSelect?: (project: Project) => void;
  onViewModeChange?: (mode: 'local' | 'fleet') => void;
  onSpawnClick?: () => void;
  onReleaseClick?: (agent: Agent) => void;
  onLogsClick?: (agent: Agent) => void;
  onThreadSelect?: (threadId: string) => void;
  /** Mobile: close sidebar handler */
  onClose?: () => void;
}

export function Sidebar({
  agents,
  projects = [],
  currentProject,
  selectedAgent,
  viewMode,
  isFleetAvailable,
  isConnected,
  isOpen = false,
  activeThreads = [],
  currentThread,
  totalUnreadThreadCount = 0,
  onAgentSelect,
  onProjectSelect,
  onViewModeChange,
  onSpawnClick,
  onReleaseClick,
  onLogsClick,
  onThreadSelect,
  onClose,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isThreadsCollapsed, setIsThreadsCollapsed] = useState(() => {
    // Initialize from localStorage
    try {
      const stored = localStorage.getItem(THREADS_COLLAPSED_KEY);
      return stored === 'true';
    } catch {
      return false;
    }
  });

  // Persist collapsed state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(THREADS_COLLAPSED_KEY, String(isThreadsCollapsed));
    } catch {
      // localStorage not available
    }
  }, [isThreadsCollapsed]);

  // Determine if we should show unified project view
  const hasProjects = projects.length > 0;

  return (
    <aside
      className="flex-1 flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="p-4 border-b border-border-subtle">
        <div className="flex items-center gap-3 mb-3">
          <LogoIcon size={28} withGlow={true} />
          <h1 className="text-lg font-display font-semibold m-0 text-text-primary">Agent Relay</h1>
          <ConnectionIndicator isConnected={isConnected} />
          {/* Mobile close button */}
          <button
            className="md:hidden ml-auto p-2 -mr-2 bg-transparent border-none text-text-muted cursor-pointer rounded-lg transition-colors hover:bg-bg-hover hover:text-text-primary"
            onClick={onClose}
            aria-label="Close sidebar"
          >
            <CloseIcon />
          </button>
        </div>

        {/* View Mode Toggle */}
        {isFleetAvailable && (
          <div className="flex bg-bg-tertiary rounded-lg p-1">
            <button
              className={`
                flex-1 py-2 px-4 bg-transparent border-none text-xs font-medium cursor-pointer rounded-md transition-all duration-150
                ${viewMode === 'local'
                  ? 'bg-bg-elevated text-accent-cyan shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'}
              `}
              onClick={() => onViewModeChange?.('local')}
            >
              Local
            </button>
            <button
              className={`
                flex-1 py-2 px-4 bg-transparent border-none text-xs font-medium cursor-pointer rounded-md transition-all duration-150
                ${viewMode === 'fleet'
                  ? 'bg-bg-elevated text-accent-cyan shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'}
              `}
              onClick={() => onViewModeChange?.('fleet')}
            >
              Fleet
            </button>
          </div>
        )}
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 py-2.5 px-3 bg-bg-tertiary m-3 rounded-lg border border-border-subtle focus-within:border-accent-cyan/50 transition-colors">
        <SearchIcon />
        <input
          type="text"
          placeholder="Search agents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 bg-transparent border-none text-text-primary text-sm outline-none placeholder:text-text-muted"
        />
        {searchQuery && (
          <button
            className="bg-transparent border-none text-text-muted cursor-pointer p-1 flex items-center justify-center hover:text-text-secondary rounded transition-colors"
            onClick={() => setSearchQuery('')}
          >
            <ClearIcon />
          </button>
        )}
      </div>

      {/* Threads Section */}
      {activeThreads.length > 0 && (
        <div className="border-b border-border-subtle">
          <ThreadList
            threads={activeThreads}
            currentThread={currentThread}
            onThreadSelect={(threadId) => onThreadSelect?.(threadId)}
            totalUnreadCount={totalUnreadThreadCount}
            isCollapsed={isThreadsCollapsed}
            onToggleCollapse={() => setIsThreadsCollapsed(!isThreadsCollapsed)}
          />
        </div>
      )}

      {/* Agent/Project List */}
      <div className="flex-1 overflow-y-auto px-2">
        {hasProjects ? (
          <ProjectList
            projects={projects}
            localAgents={agents}
            currentProject={currentProject}
            selectedAgent={selectedAgent}
            searchQuery={searchQuery}
            onProjectSelect={onProjectSelect}
            onAgentSelect={onAgentSelect}
            onReleaseClick={onReleaseClick}
            onLogsClick={onLogsClick}
            compact={true}
          />
        ) : (
          <AgentList
            agents={agents}
            selectedAgent={selectedAgent}
            searchQuery={searchQuery}
            onAgentSelect={(agent) => onAgentSelect?.(agent)}
            onReleaseClick={onReleaseClick}
            onLogsClick={onLogsClick}
            compact={true}
            showGroupStats={true}
          />
        )}
      </div>

      {/* Footer Actions */}
      <div className="p-4 border-t border-border-subtle">
        <button
          className="w-full py-3 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold text-sm cursor-pointer flex items-center justify-center gap-2 rounded-lg transition-all duration-150 hover:shadow-glow-cyan hover:-translate-y-0.5"
          onClick={onSpawnClick}
        >
          <PlusIcon />
          Spawn Agent
        </button>
      </div>
    </aside>
  );
}

function ConnectionIndicator({ isConnected }: { isConnected: boolean }) {
  return (
    <div className="flex items-center gap-1.5 ml-auto">
      <div
        className={`w-2 h-2 rounded-full ${
          isConnected
            ? 'bg-success animate-pulse-glow'
            : 'bg-text-dim'
        }`}
      />
      <span className="text-xs text-text-muted">
        {isConnected ? 'Live' : 'Offline'}
      </span>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="text-text-muted" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
