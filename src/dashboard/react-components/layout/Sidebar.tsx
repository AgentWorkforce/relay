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
const SIDEBAR_TAB_KEY = 'agent-relay-sidebar-tab';

export type SidebarTab = 'agents' | 'team';

export interface SidebarProps {
  agents: Agent[];
  /** Bridge-level agents like Architect that span multiple projects */
  bridgeAgents?: Agent[];
  projects?: Project[];
  /** Current signed-in human (to hide from Human Users list) */
  currentUserName?: string;
  /** Unread DM counts keyed by human username */
  humanUnreadCounts?: Record<string, number>;
  currentProject?: string;
  selectedAgent?: string;
  viewMode: 'local' | 'fleet' | 'channels';
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
  /** Handler when a human user is selected (opens DM) */
  onHumanSelect?: (human: Agent) => void;
  onProjectSelect?: (project: Project) => void;
  onViewModeChange?: (mode: 'local' | 'fleet' | 'channels') => void;
  onSpawnClick?: () => void;
  onReleaseClick?: (agent: Agent) => void;
  onLogsClick?: (agent: Agent) => void;
  onThreadSelect?: (threadId: string) => void;
  /** Mobile: close sidebar handler */
  onClose?: () => void;
  /** Handler for opening settings */
  onSettingsClick?: () => void;
  /** Mobile nav: Trajectory viewer toggle */
  onTrajectoryClick?: () => void;
  /** Mobile nav: Whether there's an active trajectory */
  hasActiveTrajectory?: boolean;
  /** Mobile nav: Fleet view toggle */
  onFleetClick?: () => void;
  /** Mobile nav: Whether fleet view is active */
  isFleetViewActive?: boolean;
  /** Mobile nav: Coordinator toggle */
  onCoordinatorClick?: () => void;
  /** Mobile nav: Whether multiple projects are connected (shows coordinator) */
  hasMultipleProjects?: boolean;
}

export function Sidebar({
  agents,
  bridgeAgents = [],
  projects = [],
  currentUserName,
  humanUnreadCounts = {},
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
  onHumanSelect,
  onProjectSelect,
  onViewModeChange,
  onSpawnClick,
  onReleaseClick,
  onLogsClick,
  onThreadSelect,
  onClose,
  onSettingsClick,
  onTrajectoryClick,
  hasActiveTrajectory,
  onFleetClick,
  isFleetViewActive,
  onCoordinatorClick,
  hasMultipleProjects,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SidebarTab>(() => {
    // Initialize from localStorage
    try {
      const stored = localStorage.getItem(SIDEBAR_TAB_KEY);
      return (stored === 'team' ? 'team' : 'agents') as SidebarTab;
    } catch {
      return 'agents';
    }
  });
  const [isThreadsCollapsed, setIsThreadsCollapsed] = useState(() => {
    // Initialize from localStorage
    try {
      const stored = localStorage.getItem(THREADS_COLLAPSED_KEY);
      return stored === 'true';
    } catch {
      return false;
    }
  });

  // Persist tab state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_TAB_KEY, activeTab);
    } catch {
      // localStorage not available
    }
  }, [activeTab]);

  // Persist collapsed state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(THREADS_COLLAPSED_KEY, String(isThreadsCollapsed));
    } catch {
      // localStorage not available
    }
  }, [isThreadsCollapsed]);

  // Separate AI agents from human team members
  const aiAgents = agents.filter(a => !a.isHuman);
  const humanMembers = agents.filter(
    a => a.isHuman && (!currentUserName || a.name.toLowerCase() !== currentUserName.toLowerCase())
  );
  const filteredHumanMembers = humanMembers.filter(
    (m) => !searchQuery || m.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Determine if we should show unified project view
  const hasProjects = projects.length > 0;

  return (
    <aside
      className="flex-1 flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="p-3 sm:p-4 border-b border-border-subtle">
        <div className="flex items-center gap-2 sm:gap-3 mb-3">
          <LogoIcon size={24} withGlow={true} />
          <h1 className="text-base sm:text-lg font-display font-semibold m-0 text-text-primary">Agent Relay</h1>
          <ConnectionIndicator isConnected={isConnected} />
          {/* Mobile close button */}
          <button
            className="md:hidden ml-auto p-2 -mr-1 sm:-mr-2 bg-transparent border-none text-text-muted cursor-pointer rounded-lg transition-colors hover:bg-bg-hover hover:text-text-primary active:bg-bg-hover"
            onClick={onClose}
            aria-label="Close sidebar"
          >
            <CloseIcon />
          </button>
        </div>

        {/* View Mode Toggle */}
        <div className="flex bg-bg-tertiary rounded-lg p-1">
          <button
            className={`
              flex-1 py-2 px-3 bg-transparent border-none text-xs font-medium cursor-pointer rounded-md transition-all duration-150
              ${viewMode === 'local'
                ? 'bg-bg-elevated text-accent-cyan shadow-sm'
                : 'text-text-muted hover:text-text-secondary'}
            `}
            onClick={() => onViewModeChange?.('local')}
          >
            Agents
          </button>
          <button
            className={`
              flex-1 py-2 px-3 bg-transparent border-none text-xs font-medium cursor-pointer rounded-md transition-all duration-150
              ${viewMode === 'channels'
                ? 'bg-bg-elevated text-accent-cyan shadow-sm'
                : 'text-text-muted hover:text-text-secondary'}
            `}
            onClick={() => onViewModeChange?.('channels')}
          >
            Channels
          </button>
          {isFleetAvailable && (
            <button
              className={`
                flex-1 py-2 px-3 bg-transparent border-none text-xs font-medium cursor-pointer rounded-md transition-all duration-150
                ${viewMode === 'fleet'
                  ? 'bg-bg-elevated text-accent-cyan shadow-sm'
                  : 'text-text-muted hover:text-text-secondary'}
              `}
              onClick={() => onViewModeChange?.('fleet')}
            >
              Fleet
            </button>
          )}
        </div>
      </div>

      {/* Agents/Team Tabs */}
      {humanMembers.length > 0 && (
        <div className="flex bg-bg-tertiary rounded-lg p-1 mx-3 mt-3">
          <button
            className={`
              flex-1 py-2 px-4 bg-transparent border-none text-xs font-medium cursor-pointer rounded-md transition-all duration-150 flex items-center justify-center gap-1.5
              ${activeTab === 'agents'
                ? 'bg-bg-elevated text-accent-cyan shadow-sm'
                : 'text-text-muted hover:text-text-secondary'}
            `}
            onClick={() => setActiveTab('agents')}
          >
            <RobotIcon />
            Agents
            {aiAgents.length > 0 && (
              <span className="text-[10px] opacity-70">({aiAgents.length})</span>
            )}
          </button>
          <button
            className={`
              flex-1 py-2 px-4 bg-transparent border-none text-xs font-medium cursor-pointer rounded-md transition-all duration-150 flex items-center justify-center gap-1.5
              ${activeTab === 'team'
                ? 'bg-bg-elevated text-accent-cyan shadow-sm'
                : 'text-text-muted hover:text-text-secondary'}
            `}
            onClick={() => setActiveTab('team')}
          >
            <UsersIcon />
            Team
            {humanMembers.length > 0 && (
              <span className="text-[10px] opacity-70">({humanMembers.length})</span>
            )}
          </button>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center gap-2 py-2 sm:py-2.5 px-2 sm:px-3 bg-bg-tertiary m-2 sm:m-3 rounded-lg border border-border-subtle focus-within:border-accent-cyan/50 transition-colors">
        <SearchIcon />
        <input
          type="text"
          placeholder={activeTab === 'agents' ? 'Search agents...' : 'Search team...'}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 bg-transparent border-none text-text-primary text-sm outline-none placeholder:text-text-muted"
        />
        {searchQuery && (
          <button
            className="bg-transparent border-none text-text-muted cursor-pointer p-1 flex items-center justify-center hover:text-text-secondary rounded transition-colors active:text-text-secondary"
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
        {activeTab === 'team' && humanMembers.length > 0 ? (
          /* Team Members List */
          <div className="flex flex-col gap-1 py-2">
            {filteredHumanMembers.map((member) => (
              <button
                  key={member.name}
                  onClick={() => onHumanSelect ? onHumanSelect(member) : onAgentSelect?.(member)}
                  className={`
                    flex items-center gap-3 p-3 rounded-lg border transition-all duration-150 text-left w-full
                    ${selectedAgent === member.name
                      ? 'bg-accent-cyan/10 border-accent-cyan/30'
                      : 'bg-bg-tertiary border-border-subtle hover:border-accent-cyan/30 hover:bg-bg-hover'}
                  `}
                >
                  {member.avatarUrl ? (
                    <img
                      src={member.avatarUrl}
                      alt={member.name}
                      className="w-9 h-9 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-medium text-sm">
                      {member.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{member.name}</p>
                      <p className="text-xs text-text-muted truncate">{member.role || 'Team Member'}</p>
                    </div>
                    {humanUnreadCounts[member.name] > 0 && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-accent-cyan/20 text-accent-cyan">
                        {humanUnreadCounts[member.name]}
                      </span>
                    )}
                    <div className={`w-2 h-2 rounded-full ${member.status === 'online' ? 'bg-success' : 'bg-text-dim'}`} />
                  </button>
                ))}
            {filteredHumanMembers.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 px-5 text-text-muted text-center">
                <SearchIcon />
                <p className="mt-3">No team members match "{searchQuery}"</p>
              </div>
            )}
          </div>
        ) : hasProjects ? (
          <ProjectList
            projects={projects}
            localAgents={aiAgents}
            bridgeAgents={bridgeAgents}
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
            agents={aiAgents}
            selectedAgent={selectedAgent}
            searchQuery={searchQuery}
            onAgentSelect={(agent) => onAgentSelect?.(agent)}
            onReleaseClick={onReleaseClick}
            onLogsClick={onLogsClick}
            compact={true}
            showGroupStats={true}
          />
        )}

        {/* Optional human section when viewing agents/projects */}
        {activeTab === 'agents' && humanMembers.length > 0 && (
          <div className="mt-4 mb-2 pt-3 border-t border-border-subtle">
            <div className="flex items-center justify-between px-1 pb-2">
              <p className="text-xs uppercase tracking-wide text-text-muted font-semibold m-0">Direct messages</p>
              <span className="text-[11px] text-text-muted">{filteredHumanMembers.length} member{filteredHumanMembers.length === 1 ? '' : 's'}</span>
            </div>
            <div className="flex flex-col gap-1">
              {filteredHumanMembers.length > 0 ? (
                filteredHumanMembers.map((member) => (
                  <button
                    key={member.name}
                    onClick={() => onHumanSelect ? onHumanSelect(member) : onAgentSelect?.(member)}
                    className={`
                      flex items-center gap-3 p-2.5 rounded-lg border transition-all duration-150 text-left w-full
                      ${selectedAgent === member.name
                        ? 'bg-accent-cyan/10 border-accent-cyan/30'
                        : 'bg-bg-tertiary border-border-subtle hover:border-accent-cyan/30 hover:bg-bg-hover'}
                    `}
                  >
                    {member.avatarUrl ? (
                      <img
                        src={member.avatarUrl}
                        alt={member.name}
                        className="w-8 h-8 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-medium text-xs">
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{member.name}</p>
                      <p className="text-[11px] text-text-muted truncate">{member.role || 'Team Member'}</p>
                    </div>
                    {humanUnreadCounts[member.name] > 0 && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-accent-cyan/20 text-accent-cyan">
                        {humanUnreadCounts[member.name]}
                      </span>
                    )}
                    <div className={`w-2 h-2 rounded-full ${member.status === 'online' ? 'bg-success' : 'bg-text-dim'}`} />
                  </button>
                ))
              ) : (
                <div className="flex flex-col items-center justify-center py-6 px-3 text-text-muted text-center">
                  <SearchIcon />
                  <p className="mt-2 text-xs">No team members match "{searchQuery}"</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mobile Navigation - shows items hidden in header on mobile */}
      <div className="md:hidden border-t border-border-subtle p-3">
        <p className="text-xs text-text-muted font-medium mb-2 px-1">Quick Actions</p>
        <div className="grid grid-cols-2 gap-2">
          {onFleetClick && (
            <button
              className={`flex items-center gap-2 p-2.5 rounded-lg border text-sm transition-all duration-150 ${
                isFleetViewActive
                  ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan'
                  : 'bg-bg-tertiary border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
              onClick={() => {
                onFleetClick();
                onClose?.();
              }}
            >
              <FleetIcon />
              <span>Fleet</span>
            </button>
          )}
          {onTrajectoryClick && (
            <button
              className={`flex items-center gap-2 p-2.5 rounded-lg border text-sm transition-all duration-150 relative ${
                hasActiveTrajectory
                  ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan'
                  : 'bg-bg-tertiary border-border-subtle text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
              onClick={() => {
                onTrajectoryClick();
                onClose?.();
              }}
            >
              <TrajectoryIcon />
              <span>Trajectory</span>
              {hasActiveTrajectory && (
                <span className="absolute top-1 right-1 w-2 h-2 bg-accent-cyan rounded-full animate-pulse" />
              )}
            </button>
          )}
          {hasMultipleProjects && onCoordinatorClick && (
            <button
              className="flex items-center gap-2 p-2.5 bg-bg-tertiary border border-border-subtle rounded-lg text-text-secondary text-sm transition-all duration-150 hover:bg-bg-hover hover:text-accent-purple"
              onClick={() => {
                onCoordinatorClick();
                onClose?.();
              }}
            >
              <CoordinatorIcon />
              <span>Coordinator</span>
            </button>
          )}
          <a
            href="/metrics"
            className="flex items-center gap-2 p-2.5 bg-bg-tertiary border border-border-subtle rounded-lg text-text-secondary text-sm transition-all duration-150 hover:bg-bg-hover hover:text-accent-orange no-underline"
            onClick={() => onClose?.()}
          >
            <MetricsIcon />
            <span>Metrics</span>
          </a>
        </div>
      </div>

      {/* Footer Actions */}
      <div className="p-3 sm:p-4 border-t border-border-subtle space-y-2">
        <button
          className="w-full py-2.5 sm:py-3 px-3 sm:px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold text-sm cursor-pointer flex items-center justify-center gap-2 rounded-lg transition-all duration-150 hover:shadow-glow-cyan hover:-translate-y-0.5 active:scale-[0.98]"
          onClick={onSpawnClick}
        >
          <PlusIcon />
          Spawn Agent
        </button>
        <button
          className="w-full py-2 sm:py-2.5 px-3 sm:px-4 bg-bg-tertiary text-text-secondary text-sm cursor-pointer flex items-center justify-center gap-2 rounded-lg border border-border-subtle transition-all duration-150 hover:bg-bg-hover hover:text-text-primary hover:border-border-subtle active:bg-bg-hover"
          onClick={onSettingsClick}
        >
          <SettingsIcon />
          Settings
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

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function RobotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" />
      <line x1="16" y1="16" x2="16" y2="16" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function FleetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function TrajectoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l3 9 4-18 3 9h4" />
    </svg>
  );
}

function CoordinatorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <line x1="9.5" y1="9.5" x2="6.5" y2="6.5" />
      <line x1="14.5" y1="9.5" x2="17.5" y2="6.5" />
      <line x1="9.5" y1="14.5" x2="6.5" y2="17.5" />
      <line x1="14.5" y1="14.5" x2="17.5" y2="17.5" />
    </svg>
  );
}

function MetricsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </svg>
  );
}
