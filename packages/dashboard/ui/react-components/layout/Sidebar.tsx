/**
 * Sidebar Component - Mission Control Theme
 *
 * Main navigation sidebar with channels, agents, and projects in unified view.
 * Channels are collapsed by default.
 */

import React, { useState, useEffect } from 'react';
import type { Agent, Project } from '../../types';
import type { ThreadInfo } from '../hooks/useMessages';
import { usePinnedAgents } from '../hooks/usePinnedAgents';
import { useWorkspaceStatus } from '../hooks/useWorkspaceStatus';
import { AgentList } from '../AgentList';
import { ProjectList } from '../ProjectList';
import { ThreadList } from '../ThreadList';
import { LogoIcon } from '../Logo';

const THREADS_COLLAPSED_KEY = 'agent-relay-threads-collapsed';
const SIDEBAR_TAB_KEY = 'agent-relay-sidebar-tab';
const CHANNELS_COLLAPSED_KEY = 'agent-relay-channels-collapsed';

/** Channel type for sidebar display */
export interface SidebarChannel {
  id: string;
  name: string;
  unreadCount: number;
  hasMentions?: boolean;
}

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
  /** Whether Activity feed is selected */
  isActivitySelected?: boolean;
  /** Unread count for Activity (broadcasts) */
  activityUnreadCount?: number;
  /** Handler when Activity is selected */
  onActivitySelect?: () => void;
  /** Channels for the collapsible channels section */
  channels?: SidebarChannel[];
  /** Archived channels for the collapsible archived section */
  archivedChannels?: SidebarChannel[];
  /** Currently selected channel ID */
  selectedChannelId?: string;
  /** Handler when a channel is selected */
  onChannelSelect?: (channel: SidebarChannel) => void;
  /** Handler to archive a channel */
  onArchiveChannel?: (channel: SidebarChannel) => void;
  /** Handler to unarchive a channel */
  onUnarchiveChannel?: (channel: SidebarChannel) => void;
  /** Handler to create a new channel */
  onCreateChannel?: () => void;
  /** Handler to invite members to a channel */
  onInviteToChannel?: (channel: SidebarChannel) => void;
  onAgentSelect?: (agent: Agent, project?: Project) => void;
  /** Handler when a human user is selected (opens DM) */
  onHumanSelect?: (human: Agent) => void;
  onProjectSelect?: (project: Project) => void;
  onViewModeChange?: (mode: 'local' | 'fleet' | 'channels') => void;
  onSpawnClick?: () => void;
  onReleaseClick?: (agent: Agent) => void;
  onLogsClick?: (agent: Agent) => void;
  /** Handler to view agent profile */
  onProfileClick?: (agent: Agent) => void;
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
  isActivitySelected = false,
  activityUnreadCount = 0,
  onActivitySelect,
  channels = [],
  archivedChannels = [],
  selectedChannelId,
  onChannelSelect,
  onArchiveChannel,
  onUnarchiveChannel,
  onCreateChannel,
  onInviteToChannel,
  onAgentSelect,
  onHumanSelect,
  onProjectSelect,
  onViewModeChange,
  onSpawnClick,
  onReleaseClick,
  onLogsClick,
  onProfileClick,
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
  const [isChannelsCollapsed, setIsChannelsCollapsed] = useState(() => {
    // Initialize from localStorage - default to collapsed
    try {
      const stored = localStorage.getItem(CHANNELS_COLLAPSED_KEY);
      return stored === null ? true : stored === 'true';
    } catch {
      return true;
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

  // Persist channels collapsed state
  useEffect(() => {
    try {
      localStorage.setItem(CHANNELS_COLLAPSED_KEY, String(isChannelsCollapsed));
    } catch {
      // localStorage not available
    }
  }, [isChannelsCollapsed]);

  // Total unread count for channels
  const totalChannelUnread = channels.reduce((sum, c) => sum + c.unreadCount, 0);
  const hasChannels = channels.length > 0;
  // Keep channels section open when empty so the create button is visible
  const isChannelsSectionCollapsed = hasChannels ? isChannelsCollapsed : false;
  const hasArchivedChannels = archivedChannels.length > 0;
  const [isArchivedCollapsed, setIsArchivedCollapsed] = useState(true);
  const [openChannelMenuId, setOpenChannelMenuId] = useState<string | null>(null);

  // Close menus when channel selection changes
  useEffect(() => {
    setOpenChannelMenuId(null);
  }, [selectedChannelId]);

  // Separate AI agents from human team members
  // Also filter out system agents like _DashboardUI
  const aiAgents = agents.filter(a => !a.isHuman && a.name !== '_DashboardUI');
  const humanMembers = agents.filter(
    a => a.isHuman &&
      a.name !== '_DashboardUI' &&
      (!currentUserName || a.name.toLowerCase() !== currentUserName.toLowerCase())
  );
  const filteredHumanMembers = humanMembers.filter(
    (m) => !searchQuery || m.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Pinned agents for quick access
  const { pinnedAgents, togglePin, isMaxPinned } = usePinnedAgents();

  // Check if workspace is stopped - hide channels when stopped
  const { workspace } = useWorkspaceStatus();
  const isWorkspaceStopped = workspace?.isStopped ?? false;

  // Determine if we should show unified project view
  const hasProjects = projects.length > 0;

  return (
    <aside
      className="flex-1 flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="p-3 sm:p-4 border-b border-border-subtle">
        <div className="flex items-center gap-2 sm:gap-3">
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

      {/* Activity Section - Broadcasts */}
      <div className="border-b border-border-subtle px-2 py-2">
        <button
          onClick={onActivitySelect}
          className={`
            w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left text-sm transition-colors
            ${isActivitySelected
              ? 'bg-accent-cyan/10 text-text-primary border border-accent-cyan/30'
              : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary border border-transparent'}
          `}
        >
          <ActivityIcon />
          <span className={`flex-1 ${activityUnreadCount > 0 ? 'font-semibold text-text-primary' : ''}`}>
            Activity
          </span>
          {activityUnreadCount > 0 && (
            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full bg-accent-cyan/20 text-accent-cyan">
              {activityUnreadCount}
            </span>
          )}
        </button>
      </div>

      {/* Channels Section - Collapsible (hidden when workspace stopped) */}
      {!isWorkspaceStopped && (
      <div className="border-b border-border-subtle">
        <button
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-wide hover:bg-bg-hover transition-colors"
          onClick={() => setIsChannelsCollapsed(!isChannelsCollapsed)}
        >
          <span className="flex items-center gap-2">
            <HashIcon />
            Channels
            {totalChannelUnread > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-accent-cyan/20 text-accent-cyan">
                {totalChannelUnread}
              </span>
            )}
          </span>
          <ChevronIcon className={`transition-transform ${isChannelsSectionCollapsed ? '' : 'rotate-180'}`} />
        </button>
        {!isChannelsSectionCollapsed && (
          <div className="px-2 pb-2 space-y-0.5 max-h-40 md:max-h-none overflow-y-auto">
            {channels.map(channel => (
              <div key={channel.id} className="group relative">
                <button
                  onClick={() => onChannelSelect?.(channel)}
                  className={`
                    w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors
                    ${selectedChannelId === channel.id
                      ? 'bg-accent-cyan/10 text-text-primary'
                      : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}
                  `}
                >
                  <span className="text-text-muted">#</span>
                  <span className={`flex-1 truncate ${channel.unreadCount > 0 ? 'font-semibold text-text-primary' : ''}`}>
                    {channel.name}
                  </span>
                  {channel.unreadCount > 0 && (
                    <span className={`
                      text-[11px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center
                      ${channel.hasMentions ? 'bg-red-500/20 text-red-400' : 'bg-accent-cyan/20 text-accent-cyan'}
                    `}>
                      {channel.unreadCount}
                    </span>
                  )}
                </button>
                {(onInviteToChannel || onArchiveChannel) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenChannelMenuId(openChannelMenuId === channel.id ? null : channel.id);
                    }}
                    title="Channel actions"
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-bg-tertiary text-text-muted hover:text-text-primary transition-all"
                  >
                    <MoreIcon />
                  </button>
                )}
                {openChannelMenuId === channel.id && (
                  <div className="absolute right-0 top-full mt-1 z-30 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg py-1 min-w-[160px]">
                    {onInviteToChannel && (
                      <MenuButton
                        onClick={() => {
                          onInviteToChannel(channel);
                          setOpenChannelMenuId(null);
                        }}
                      >
                        <UserPlusIcon />
                        <span>Invite members</span>
                      </MenuButton>
                    )}
                    {onArchiveChannel && (
                      <MenuButton
                        onClick={() => {
                          onArchiveChannel(channel);
                          setOpenChannelMenuId(null);
                        }}
                      >
                        <ArchiveIcon />
                        <span>Archive</span>
                      </MenuButton>
                    )}
                  </div>
                )}
              </div>
            ))}
            {onCreateChannel && (
              <button
                onClick={onCreateChannel}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm text-text-muted hover:bg-bg-hover hover:text-text-secondary transition-colors"
              >
                <PlusIcon />
                <span>{hasChannels ? 'Add channel' : 'Create your first channel'}</span>
              </button>
            )}
          </div>
        )}

        {hasArchivedChannels && (
          <div className="mt-1 border-t border-border-subtle">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-text-muted uppercase tracking-wide hover:bg-bg-hover transition-colors"
              onClick={() => setIsArchivedCollapsed(!isArchivedCollapsed)}
            >
              <span className="flex items-center gap-2">
                <ArchiveIcon />
                Archived
                <span className="text-[10px] opacity-80">({archivedChannels.length})</span>
              </span>
              <ChevronIcon className={`transition-transform ${isArchivedCollapsed ? '' : 'rotate-180'}`} />
            </button>
            {!isArchivedCollapsed && (
              <div className="px-2 pb-2 space-y-0.5 max-h-32 md:max-h-none overflow-y-auto">
                {archivedChannels.map((channel) => (
                  <div key={channel.id} className="group relative">
                    <button
                      onClick={() => onChannelSelect?.(channel)}
                      className={`
                        w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors
                        ${selectedChannelId === channel.id
                          ? 'bg-bg-tertiary text-text-primary'
                          : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}
                      `}
                    >
                      <span className="text-text-muted">#</span>
                      <span className="flex-1 truncate">{channel.name}</span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-border-subtle text-text-muted">
                        Archived
                      </span>
                    </button>
                    {onUnarchiveChannel && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onUnarchiveChannel(channel);
                        }}
                        title="Unarchive channel"
                        className="absolute right-1 top-1/2 -translate-y-1/2 px-2 py-1 rounded-md bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-xs flex items-center gap-1"
                      >
                        <UnarchiveIcon />
                        <span>Unarchive</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
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
            onProfileClick={onProfileClick}
            compact={true}
          />
        ) : (
          <AgentList
            agents={aiAgents}
            selectedAgent={selectedAgent}
            searchQuery={searchQuery}
            pinnedAgents={pinnedAgents}
            isMaxPinned={isMaxPinned}
            onAgentSelect={(agent) => onAgentSelect?.(agent)}
            onReleaseClick={onReleaseClick}
            onLogsClick={onLogsClick}
            onProfileClick={onProfileClick}
            onPinToggle={(agent) => togglePin(agent.name)}
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

function MenuButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
    >
      {children}
    </button>
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

function UserPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h18" />
      <path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7" />
      <rect x="3" y="3" width="18" height="4" rx="1" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

function UnarchiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h18" />
      <path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7" />
      <rect x="3" y="3" width="18" height="4" rx="1" />
      <path d="M12 11v6" />
      <path d="M9 14l3-3 3 3" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
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

function ActivityIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
