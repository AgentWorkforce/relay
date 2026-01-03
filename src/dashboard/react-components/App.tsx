/**
 * Dashboard V2 - Main Application Component
 *
 * Root component that combines sidebar, header, and main content area.
 * Manages global state via hooks and provides context to child components.
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Agent, Project } from '../types';
import { Sidebar } from './layout/Sidebar';
import { Header } from './layout/Header';
import { MessageList } from './MessageList';
import { ThreadPanel } from './ThreadPanel';
import { CommandPalette, type TaskCreateRequest, PRIORITY_CONFIG } from './CommandPalette';
import { SpawnModal, type SpawnConfig } from './SpawnModal';
import { NewConversationModal } from './NewConversationModal';
import { SettingsPanel, defaultSettings, type Settings } from './SettingsPanel';
import { ConversationHistory } from './ConversationHistory';
import { MentionAutocomplete, getMentionQuery, completeMentionInValue, type HumanUser } from './MentionAutocomplete';
import { FileAutocomplete, getFileQuery, completeFileInValue } from './FileAutocomplete';
import { WorkspaceSelector, type Workspace } from './WorkspaceSelector';
import { AddWorkspaceModal } from './AddWorkspaceModal';
import { LogViewerPanel } from './LogViewerPanel';
import { TrajectoryViewer } from './TrajectoryViewer';
import { DecisionQueue, type Decision } from './DecisionQueue';
import { FleetOverview } from './FleetOverview';
import type { ServerInfo } from './ServerCard';
import { TypingIndicator } from './TypingIndicator';
import { OnlineUsersIndicator } from './OnlineUsersIndicator';
import { UserProfilePanel } from './UserProfilePanel';
import { CoordinatorPanel } from './CoordinatorPanel';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgents } from './hooks/useAgents';
import { useMessages } from './hooks/useMessages';
import { useOrchestrator } from './hooks/useOrchestrator';
import { useTrajectory } from './hooks/useTrajectory';
import { useRecentRepos } from './hooks/useRecentRepos';
import { usePresence, type UserPresence } from './hooks/usePresence';
import { useCloudSessionOptional } from './CloudSessionProvider';
import { api, convertApiDecision } from '../lib/api';
import type { CurrentUser } from './MessageList';

/**
 * Check if a sender is a human user (not an agent or system name)
 * Extracts the logic for identifying human users to avoid duplication
 */
function isHumanSender(sender: string, agentNames: Set<string>): boolean {
  return sender !== 'Dashboard' &&
    sender !== '*' &&
    !agentNames.has(sender.toLowerCase());
}

export interface AppProps {
  /** Initial WebSocket URL (optional, defaults to current host) */
  wsUrl?: string;
  /** Orchestrator API URL (optional, defaults to localhost:3456) */
  orchestratorUrl?: string;
}

export function App({ wsUrl, orchestratorUrl }: AppProps) {
  // WebSocket connection for real-time data (per-project daemon)
  const { data, isConnected, error: wsError } = useWebSocket({ url: wsUrl });

  // Orchestrator for multi-workspace management
  const {
    workspaces,
    activeWorkspaceId,
    agents: orchestratorAgents,
    isConnected: isOrchestratorConnected,
    isLoading: isOrchestratorLoading,
    error: orchestratorError,
    switchWorkspace,
    addWorkspace,
    removeWorkspace,
    spawnAgent: orchestratorSpawnAgent,
    stopAgent: orchestratorStopAgent,
  } = useOrchestrator({ apiUrl: orchestratorUrl });

  // Cloud session for user info (GitHub avatar/username)
  const cloudSession = useCloudSessionOptional();

  // Derive current user from cloud session (falls back to undefined in non-cloud mode)
  const currentUser: CurrentUser | undefined = cloudSession?.user
    ? {
        displayName: cloudSession.user.githubUsername,
        avatarUrl: cloudSession.user.avatarUrl,
      }
    : undefined;

  // Presence tracking for online users and typing indicators
  const { onlineUsers, typingUsers, sendTyping, isConnected: isPresenceConnected } = usePresence({
    currentUser: currentUser
      ? { username: currentUser.displayName, avatarUrl: currentUser.avatarUrl }
      : undefined,
  });

  // User profile panel state
  const [selectedUserProfile, setSelectedUserProfile] = useState<UserPresence | null>(null);

  // View mode state
  const [viewMode, setViewMode] = useState<'local' | 'fleet'>('local');

  // Project state for unified navigation (converted from workspaces)
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<string | undefined>();

  // Spawn modal state
  const [isSpawnModalOpen, setIsSpawnModalOpen] = useState(false);
  const [isSpawning, setIsSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // Add workspace modal state
  const [isAddWorkspaceOpen, setIsAddWorkspaceOpen] = useState(false);
  const [isAddingWorkspace, setIsAddingWorkspace] = useState(false);
  const [addWorkspaceError, setAddWorkspaceError] = useState<string | null>(null);

  // Command palette state
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

  // Settings panel state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  // Conversation history panel state
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // New conversation modal state
  const [isNewConversationOpen, setIsNewConversationOpen] = useState(false);

  // Log viewer panel state
  const [logViewerAgent, setLogViewerAgent] = useState<Agent | null>(null);

  // Trajectory panel state
  const [isTrajectoryOpen, setIsTrajectoryOpen] = useState(false);
  const {
    steps: trajectorySteps,
    status: trajectoryStatus,
    history: trajectoryHistory,
    isLoading: isTrajectoryLoading,
    selectTrajectory,
    selectedTrajectoryId,
  } = useTrajectory({
    autoPoll: isTrajectoryOpen, // Only poll when panel is open
  });

  // Recent repos tracking
  const { recentRepos, addRecentRepo, getRecentProjects } = useRecentRepos();

  // Coordinator panel state
  const [isCoordinatorOpen, setIsCoordinatorOpen] = useState(false);

  // Decision queue state
  const [isDecisionQueueOpen, setIsDecisionQueueOpen] = useState(false);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [decisionProcessing, setDecisionProcessing] = useState<Record<string, boolean>>({});

  // Fleet overview state
  const [isFleetViewActive, setIsFleetViewActive] = useState(false);
  const [fleetServers, setFleetServers] = useState<ServerInfo[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | undefined>();

  // Task creation state (tasks are stored in beads, not local state)
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  // Mobile sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Unread message notification state for mobile
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);
  const lastSeenMessageCountRef = useRef<number>(0);
  const sidebarClosedRef = useRef<boolean>(true); // Track if sidebar is currently closed

  // Close sidebar when selecting an agent or project on mobile
  const closeSidebarOnMobile = useCallback(() => {
    if (window.innerWidth <= 768) {
      setIsSidebarOpen(false);
    }
  }, []);

  // Agent state management
  const {
    agents,
    groups,
    selectedAgent,
    selectAgent,
    searchQuery,
    setSearchQuery,
    totalCount,
    onlineCount,
    needsAttentionCount,
  } = useAgents({
    agents: data?.agents ?? [],
  });

  // Message state management
  const {
    messages,
    threadMessages,
    currentChannel,
    setCurrentChannel,
    currentThread,
    setCurrentThread,
    activeThreads,
    totalUnreadThreadCount,
    sendMessage,
    isSending,
    sendError,
  } = useMessages({
    messages: data?.messages ?? [],
    senderName: currentUser?.displayName,
  });

  // Extract human users from messages (users who are not agents)
  // This enables @ mentioning other human users in cloud mode
  const humanUsers = useMemo((): HumanUser[] => {
    const agentNames = new Set(agents.map((a) => a.name.toLowerCase()));
    const seenUsers = new Map<string, HumanUser>();

    // Include current user if in cloud mode
    if (currentUser) {
      seenUsers.set(currentUser.displayName.toLowerCase(), {
        username: currentUser.displayName,
        avatarUrl: currentUser.avatarUrl,
      });
    }

    // Extract unique human users from message senders
    for (const msg of data?.messages ?? []) {
      const sender = msg.from;
      if (sender && isHumanSender(sender, agentNames) && !seenUsers.has(sender.toLowerCase())) {
        seenUsers.set(sender.toLowerCase(), {
          username: sender,
          // Note: We don't have avatar URLs for users from messages
          // unless we fetch them separately
        });
      }
    }

    return Array.from(seenUsers.values());
  }, [data?.messages, agents, currentUser]);

  // Track unread messages when sidebar is closed on mobile
  useEffect(() => {
    // Only track on mobile viewport
    const isMobile = window.innerWidth <= 768;
    if (!isMobile) {
      setHasUnreadMessages(false);
      return;
    }

    const messageCount = messages.length;

    // If sidebar is closed and we have new messages since last seen
    if (!isSidebarOpen && messageCount > lastSeenMessageCountRef.current) {
      setHasUnreadMessages(true);
    }

    // Update the ref based on current sidebar state
    sidebarClosedRef.current = !isSidebarOpen;
  }, [messages.length, isSidebarOpen]);

  // Clear unread state and update last seen count when sidebar opens
  useEffect(() => {
    if (isSidebarOpen) {
      setHasUnreadMessages(false);
      lastSeenMessageCountRef.current = messages.length;
    }
  }, [isSidebarOpen, messages.length]);

  // Initialize last seen message count on mount
  useEffect(() => {
    lastSeenMessageCountRef.current = messages.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check if fleet view is available
  const isFleetAvailable = Boolean(data?.fleet?.servers?.length) || workspaces.length > 0;

  // Convert workspaces to projects for unified navigation
  useEffect(() => {
    if (workspaces.length > 0) {
      // Convert workspaces to projects
      const projectList: Project[] = workspaces.map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        name: workspace.name,
        agents: orchestratorAgents
          .filter((a) => a.workspaceId === workspace.id)
          .map((a) => ({
            name: a.name,
            status: a.status === 'running' ? 'online' : 'offline',
            isSpawned: true,
            cli: a.provider,
          })) as Agent[],
        lead: undefined,
      }));
      setProjects(projectList);
      setCurrentProject(activeWorkspaceId);
    }
  }, [workspaces, orchestratorAgents, activeWorkspaceId]);

  // Fetch bridge/project data for multi-project mode
  useEffect(() => {
    if (workspaces.length > 0) return; // Skip if using orchestrator

    const fetchProjects = async () => {
      const result = await api.getBridgeData();
      if (result.success && result.data) {
        // Bridge data returns { projects, messages, connected }
        const bridgeData = result.data as {
          projects?: Array<{
            id: string;
            name?: string;
            path: string;
            connected?: boolean;
            agents?: Array<{ name: string; status: string; task?: string; cli?: string }>;
            lead?: { name: string; connected: boolean };
          }>;
          connected?: boolean;
          currentProjectPath?: string;
        };

        if (bridgeData.projects && bridgeData.projects.length > 0) {
          const projectList: Project[] = bridgeData.projects.map((p) => ({
            id: p.id,
            path: p.path,
            name: p.name || p.path.split('/').pop(),
            agents: (p.agents || []).map((a) => ({
              name: a.name,
              status: a.status === 'online' || a.status === 'active' ? 'online' : 'offline',
              currentTask: a.task,
              cli: a.cli,
            })) as Agent[],
            lead: p.lead,
          }));
          setProjects(projectList);
          // Set first project as current if none selected
          if (!currentProject && projectList.length > 0) {
            setCurrentProject(projectList[0].id);
          }
        }
      }
    };

    // Fetch immediately on mount
    fetchProjects();
    // Poll for updates
    const interval = setInterval(fetchProjects, 5000);
    return () => clearInterval(interval);
  }, [workspaces.length, currentProject]);

  // Bridge-level agents (like Architect) that should be shown separately
  const BRIDGE_AGENT_NAMES = ['architect'];

  // Separate bridge-level agents from regular project agents
  const { bridgeAgents, projectAgents } = useMemo(() => {
    const bridge: Agent[] = [];
    const project: Agent[] = [];

    for (const agent of agents) {
      if (BRIDGE_AGENT_NAMES.includes(agent.name.toLowerCase())) {
        bridge.push(agent);
      } else {
        project.push(agent);
      }
    }

    return { bridgeAgents: bridge, projectAgents: project };
  }, [agents]);

  // Merge local daemon agents into their project when we have bridge projects
  // This prevents agents from appearing under "Local" instead of their project folder
  const mergedProjects = useMemo(() => {
    if (projects.length === 0) return projects;

    // Get local agent names (excluding bridge agents)
    const localAgentNames = new Set(projectAgents.map((a) => a.name.toLowerCase()));
    if (localAgentNames.size === 0) return projects;

    // Find the current project (the one whose daemon we're connected to)
    // This is typically the first project or the one marked as current
    return projects.map((project, index) => {
      // Merge local agents into the current/first project
      // Local agents should appear in their actual project, not "Local"
      const isCurrentDaemonProject = index === 0 || project.id === currentProject;

      if (isCurrentDaemonProject) {
        // Merge local agents with project agents, avoiding duplicates
        const existingNames = new Set(project.agents.map((a) => a.name.toLowerCase()));
        const newAgents = projectAgents.filter((a) => !existingNames.has(a.name.toLowerCase()));

        return {
          ...project,
          agents: [...project.agents, ...newAgents],
        };
      }

      return project;
    });
  }, [projects, projectAgents, currentProject]);

  // Determine if local agents should be shown separately
  // Only show "Local" folder if we don't have bridge projects to merge them into
  const localAgentsForSidebar = useMemo(() => {
    if (mergedProjects.length > 0) {
      // Don't show local agents separately - they're merged into projects
      return [];
    }
    return projectAgents;
  }, [mergedProjects, projectAgents]);

  // Handle workspace selection
  const handleWorkspaceSelect = useCallback(async (workspace: Workspace) => {
    try {
      await switchWorkspace(workspace.id);
    } catch (err) {
      console.error('Failed to switch workspace:', err);
    }
  }, [switchWorkspace]);

  // Handle add workspace
  const handleAddWorkspace = useCallback(async (path: string, name?: string) => {
    setIsAddingWorkspace(true);
    setAddWorkspaceError(null);
    try {
      await addWorkspace(path, name);
      setIsAddWorkspaceOpen(false);
    } catch (err) {
      setAddWorkspaceError(err instanceof Error ? err.message : 'Failed to add workspace');
      throw err;
    } finally {
      setIsAddingWorkspace(false);
    }
  }, [addWorkspace]);

  // Handle project selection (also switches workspace if using orchestrator)
  const handleProjectSelect = useCallback((project: Project) => {
    setCurrentProject(project.id);

    // Track as recently accessed
    addRecentRepo(project);

    // Switch workspace if using orchestrator
    if (workspaces.length > 0) {
      switchWorkspace(project.id).catch((err) => {
        console.error('Failed to switch workspace:', err);
      });
    }

    if (project.agents.length > 0) {
      selectAgent(project.agents[0].name);
      setCurrentChannel(project.agents[0].name);
    }
    closeSidebarOnMobile();
  }, [selectAgent, setCurrentChannel, closeSidebarOnMobile, workspaces.length, switchWorkspace, addRecentRepo]);

  // Handle agent selection
  const handleAgentSelect = useCallback((agent: Agent) => {
    selectAgent(agent.name);
    setCurrentChannel(agent.name);
    closeSidebarOnMobile();
  }, [selectAgent, setCurrentChannel, closeSidebarOnMobile]);

  // Handle spawn button click
  const handleSpawnClick = useCallback(() => {
    setSpawnError(null);
    setIsSpawnModalOpen(true);
  }, []);

  // Handle settings click
  const handleSettingsClick = useCallback(() => {
    setIsSettingsOpen(true);
  }, []);

  // Handle history click
  const handleHistoryClick = useCallback(() => {
    setIsHistoryOpen(true);
  }, []);

  // Handle new conversation click
  const handleNewConversationClick = useCallback(() => {
    setIsNewConversationOpen(true);
  }, []);

  // Handle coordinator click
  const handleCoordinatorClick = useCallback(() => {
    setIsCoordinatorOpen(true);
  }, []);

  // Handle send from new conversation modal - select the channel after sending
  const handleNewConversationSend = useCallback(async (to: string, content: string): Promise<boolean> => {
    const success = await sendMessage(to, content);
    if (success) {
      // Switch to the channel we just messaged
      if (to === '*') {
        selectAgent(null);
        setCurrentChannel('general');
      } else {
        const targetAgent = agents.find((a) => a.name === to);
        if (targetAgent) {
          selectAgent(targetAgent.name);
          setCurrentChannel(targetAgent.name);
        } else {
          setCurrentChannel(to);
        }
      }
    }
    return success;
  }, [sendMessage, selectAgent, setCurrentChannel, agents]);

  // Handle spawn agent
  const handleSpawn = useCallback(async (config: SpawnConfig): Promise<boolean> => {
    setIsSpawning(true);
    setSpawnError(null);
    try {
      // Use orchestrator if workspaces are available
      if (workspaces.length > 0 && activeWorkspaceId) {
        await orchestratorSpawnAgent(config.name, undefined, config.command);
        return true;
      }

      // Fallback to legacy API
      const result = await api.spawnAgent({
        name: config.name,
        cli: config.command,
        team: config.team,
        shadowMode: config.shadowMode,
        shadowOf: config.shadowOf,
        shadowAgent: config.shadowAgent,
        shadowTriggers: config.shadowTriggers,
        shadowSpeakOn: config.shadowSpeakOn,
      });
      if (!result.success) {
        setSpawnError(result.error || 'Failed to spawn agent');
        return false;
      }
      return true;
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : 'Failed to spawn agent');
      return false;
    } finally {
      setIsSpawning(false);
    }
  }, [workspaces.length, activeWorkspaceId, orchestratorSpawnAgent]);

  // Handle release/kill agent
  const handleReleaseAgent = useCallback(async (agent: Agent) => {
    if (!agent.isSpawned) return;

    const confirmed = window.confirm(`Are you sure you want to release agent "${agent.name}"?`);
    if (!confirmed) return;

    try {
      // Use orchestrator if workspaces are available
      if (workspaces.length > 0 && activeWorkspaceId) {
        await orchestratorStopAgent(agent.name);
        return;
      }

      // Fallback to legacy API
      const result = await api.releaseAgent(agent.name);
      if (!result.success) {
        console.error('Failed to release agent:', result.error);
      }
    } catch (err) {
      console.error('Failed to release agent:', err);
    }
  }, [workspaces.length, activeWorkspaceId, orchestratorStopAgent]);

  // Handle logs click - open log viewer panel
  const handleLogsClick = useCallback((agent: Agent) => {
    setLogViewerAgent(agent);
  }, []);

  // Fetch fleet servers periodically when fleet view is active
  useEffect(() => {
    if (!isFleetViewActive) return;

    const fetchFleetServers = async () => {
      const result = await api.getFleetServers();
      if (result.success && result.data) {
        // Convert FleetServer to ServerInfo format
        const servers: ServerInfo[] = result.data.servers.map((s) => ({
          id: s.id,
          name: s.name,
          url: s.id === 'local' ? window.location.origin : `http://${s.id}`,
          status: s.status === 'healthy' ? 'online' : s.status === 'degraded' ? 'degraded' : 'offline',
          agentCount: s.agents.length,
          uptime: s.uptime,
          lastSeen: s.lastHeartbeat,
        }));
        setFleetServers(servers);
      }
    };

    fetchFleetServers();
    const interval = setInterval(fetchFleetServers, 5000);
    return () => clearInterval(interval);
  }, [isFleetViewActive]);

  // Fetch decisions periodically when queue is open
  useEffect(() => {
    if (!isDecisionQueueOpen) return;

    const fetchDecisions = async () => {
      const result = await api.getDecisions();
      if (result.success && result.data) {
        setDecisions(result.data.decisions.map(convertApiDecision));
      }
    };

    fetchDecisions();
    const interval = setInterval(fetchDecisions, 5000);
    return () => clearInterval(interval);
  }, [isDecisionQueueOpen]);

  // Decision queue handlers
  const handleDecisionApprove = useCallback(async (decisionId: string, optionId?: string) => {
    setDecisionProcessing((prev) => ({ ...prev, [decisionId]: true }));
    try {
      const result = await api.approveDecision(decisionId, optionId);
      if (result.success) {
        setDecisions((prev) => prev.filter((d) => d.id !== decisionId));
      } else {
        console.error('Failed to approve decision:', result.error);
      }
    } catch (err) {
      console.error('Failed to approve decision:', err);
    } finally {
      setDecisionProcessing((prev) => ({ ...prev, [decisionId]: false }));
    }
  }, []);

  const handleDecisionReject = useCallback(async (decisionId: string, reason?: string) => {
    setDecisionProcessing((prev) => ({ ...prev, [decisionId]: true }));
    try {
      const result = await api.rejectDecision(decisionId, reason);
      if (result.success) {
        setDecisions((prev) => prev.filter((d) => d.id !== decisionId));
      } else {
        console.error('Failed to reject decision:', result.error);
      }
    } catch (err) {
      console.error('Failed to reject decision:', err);
    } finally {
      setDecisionProcessing((prev) => ({ ...prev, [decisionId]: false }));
    }
  }, []);

  const handleDecisionDismiss = useCallback(async (decisionId: string) => {
    const result = await api.dismissDecision(decisionId);
    if (result.success) {
      setDecisions((prev) => prev.filter((d) => d.id !== decisionId));
    }
  }, []);

  // Task creation handler - creates bead and sends relay notification
  const handleTaskCreate = useCallback(async (task: TaskCreateRequest) => {
    setIsCreatingTask(true);
    try {
      // Map UI priority to beads priority number
      const beadsPriority = PRIORITY_CONFIG[task.priority].beadsPriority;

      // Create bead via API
      const result = await api.createBead({
        title: task.title,
        assignee: task.agentName,
        priority: beadsPriority,
        type: 'task',
      });

      if (result.success && result.data?.bead) {
        // Send relay notification to agent (non-interrupting)
        await api.sendRelayMessage({
          to: task.agentName,
          content: `📋 New task assigned: "${task.title}" (P${beadsPriority})\nCheck \`bd ready\` for details.`,
        });
        console.log('Task created:', result.data.bead.id);
      } else {
        console.error('Failed to create task bead:', result.error);
        throw new Error(result.error || 'Failed to create task');
      }
    } catch (err) {
      console.error('Failed to create task:', err);
      throw err;
    } finally {
      setIsCreatingTask(false);
    }
  }, []);

  // Handle command palette
  const handleCommandPaletteOpen = useCallback(() => {
    setIsCommandPaletteOpen(true);
  }, []);

  const handleCommandPaletteClose = useCallback(() => {
    setIsCommandPaletteOpen(false);
  }, []);

  // Apply theme to document
  React.useEffect(() => {
    const applyTheme = (theme: 'light' | 'dark' | 'system') => {
      let effectiveTheme: 'light' | 'dark';

      if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        effectiveTheme = prefersDark ? 'dark' : 'light';
      } else {
        effectiveTheme = theme;
      }

      document.documentElement.setAttribute('data-theme', effectiveTheme);
    };

    applyTheme(settings.theme);

    if (settings.theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => applyTheme('system');
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, [settings.theme]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
      }

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 's') {
        e.preventDefault();
        handleSpawnClick();
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        handleNewConversationClick();
      }

      if (e.key === 'Escape') {
        setIsCommandPaletteOpen(false);
        setIsSpawnModalOpen(false);
        setIsNewConversationOpen(false);
        setIsTrajectoryOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSpawnClick, handleNewConversationClick]);

  return (
    <div className="flex h-screen bg-bg-deep font-sans text-text-primary">
      {/* Mobile Sidebar Overlay */}
      <div
        className={`
          fixed inset-0 bg-black/60 backdrop-blur-sm z-[999] transition-opacity duration-200
          md:hidden
          ${isSidebarOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
        `}
        onClick={() => setIsSidebarOpen(false)}
      />

      {/* Sidebar with Workspace Selector */}
      <div className={`
        flex flex-col w-[280px] max-md:w-[85vw] max-md:max-w-[280px] h-screen bg-bg-primary border-r border-border-subtle
        fixed left-0 top-0 z-[1000] transition-transform duration-200
        md:relative md:translate-x-0 md:flex-shrink-0
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Workspace Selector */}
        <div className="p-3 border-b border-sidebar-border">
          <WorkspaceSelector
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelect={handleWorkspaceSelect}
            onAddWorkspace={() => setIsAddWorkspaceOpen(true)}
            isLoading={isOrchestratorLoading}
          />
        </div>

        {/* Sidebar */}
        <Sidebar
          agents={localAgentsForSidebar}
          bridgeAgents={bridgeAgents}
          projects={mergedProjects}
          currentProject={currentProject}
          selectedAgent={selectedAgent?.name}
          viewMode={viewMode}
          isFleetAvailable={isFleetAvailable}
          isConnected={isConnected || isOrchestratorConnected}
          isOpen={isSidebarOpen}
          activeThreads={activeThreads}
          currentThread={currentThread}
          totalUnreadThreadCount={totalUnreadThreadCount}
          onAgentSelect={handleAgentSelect}
          onProjectSelect={handleProjectSelect}
          onViewModeChange={setViewMode}
          onSpawnClick={handleSpawnClick}
          onReleaseClick={handleReleaseAgent}
          onLogsClick={handleLogsClick}
          onThreadSelect={setCurrentThread}
          onClose={() => setIsSidebarOpen(false)}
        />
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-bg-secondary/50 overflow-hidden">
        {/* Header - sticky on mobile */}
        <div className="sticky top-0 z-50 flex-shrink-0">
          <Header
          currentChannel={currentChannel}
          selectedAgent={selectedAgent}
          projects={mergedProjects}
          currentProject={mergedProjects.find(p => p.id === currentProject) || null}
          recentProjects={getRecentProjects(mergedProjects)}
          onProjectChange={handleProjectSelect}
          onCommandPaletteOpen={handleCommandPaletteOpen}
          onSettingsClick={handleSettingsClick}
          onHistoryClick={handleHistoryClick}
          onNewConversationClick={handleNewConversationClick}
          onCoordinatorClick={handleCoordinatorClick}
          onFleetClick={() => setIsFleetViewActive(!isFleetViewActive)}
          isFleetViewActive={isFleetViewActive}
          onTrajectoryClick={() => setIsTrajectoryOpen(true)}
          hasActiveTrajectory={trajectoryStatus?.active}
          onMenuClick={() => setIsSidebarOpen(true)}
          hasUnreadNotifications={hasUnreadMessages}
        />
        {/* Online users indicator - only show in cloud mode */}
        {currentUser && onlineUsers.length > 0 && (
          <div className="flex items-center justify-end px-4 py-1 bg-bg-tertiary/80 border-b border-border-subtle">
            <OnlineUsersIndicator
              onlineUsers={onlineUsers}
              onUserClick={setSelectedUserProfile}
            />
          </div>
        )}
        </div>

        {/* Content Area */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Message List */}
          <div className={`flex-1 min-h-0 overflow-y-auto ${currentThread ? 'hidden md:block md:flex-[2]' : ''}`}>
            {wsError ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted text-center px-4">
                <ErrorIcon />
                <h2 className="m-0 mb-2 font-display text-text-primary">Connection Error</h2>
                <p className="text-text-secondary">{wsError.message}</p>
                <button
                  className="mt-6 py-3 px-6 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold border-none rounded-xl cursor-pointer transition-all duration-150 hover:shadow-glow-cyan hover:-translate-y-0.5"
                  onClick={() => window.location.reload()}
                >
                  Retry Connection
                </button>
              </div>
            ) : !data ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted text-center">
                <LoadingSpinner />
                <p className="font-display text-text-secondary">Connecting to dashboard...</p>
              </div>
            ) : isFleetViewActive ? (
              <div className="p-4 h-full overflow-y-auto">
                <FleetOverview
                  servers={fleetServers}
                  agents={agents}
                  selectedServerId={selectedServerId}
                  onServerSelect={setSelectedServerId}
                  onServerReconnect={(serverId) => {
                    // TODO: Implement server reconnect via API
                    console.log('Reconnecting to server:', serverId);
                  }}
                  isLoading={!data}
                />
              </div>
            ) : (
              <MessageList
                messages={messages}
                currentChannel={currentChannel}
                currentThread={currentThread}
                onThreadClick={(messageId) => setCurrentThread(messageId)}
                highlightedMessageId={currentThread ?? undefined}
                agents={data?.agents}
                currentUser={currentUser}
              />
            )}
          </div>

          {/* Thread Panel */}
          {currentThread && (() => {
            // Find original message: first try by ID (reply chain), then by thread name (topic thread)
            let originalMessage = messages.find((m) => m.id === currentThread);
            const isTopicThread = !originalMessage;

            if (!originalMessage) {
              // Topic thread: find oldest message with this thread name
              const threadMsgs = messages
                .filter((m) => m.thread === currentThread)
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
              originalMessage = threadMsgs[0] ?? null;
            }

            return (
              <div className="w-full md:w-[400px] md:min-w-[320px] md:max-w-[500px] flex-shrink-0">
                <ThreadPanel
                  originalMessage={originalMessage ?? null}
                  replies={threadMessages(currentThread)}
                  onClose={() => setCurrentThread(null)}
                  onReply={async (content) => {
                    // For topic threads, broadcast to all; for reply chains, reply to the other participant
                    let recipient = '*';
                    if (!isTopicThread && originalMessage) {
                      // If current user sent the original message, reply to the recipient
                      // If someone else sent it, reply to the sender
                      const isFromCurrentUser = originalMessage.from === 'Dashboard' ||
                        (currentUser && originalMessage.from === currentUser.displayName);
                      recipient = isFromCurrentUser
                        ? originalMessage.to
                        : originalMessage.from;
                    }
                    return sendMessage(recipient, content, currentThread);
                  }}
                  isSending={isSending}
                  currentUser={currentUser}
                />
              </div>
            );
          })()}
        </div>

        {/* Typing Indicator */}
        {typingUsers.length > 0 && (
          <div className="px-4 bg-bg-tertiary border-t border-border-subtle">
            <TypingIndicator typingUsers={typingUsers} />
          </div>
        )}

        {/* Message Composer */}
        <div className="p-4 bg-bg-tertiary border-t border-border-subtle">
          <MessageComposer
            recipient={currentChannel === 'general' ? '*' : currentChannel}
            agents={agents}
            humanUsers={humanUsers}
            onSend={sendMessage}
            onTyping={sendTyping}
            isSending={isSending}
            error={sendError}
          />
        </div>
      </main>

      {/* Command Palette */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={handleCommandPaletteClose}
        agents={agents}
        projects={projects}
        currentProject={currentProject}
        onAgentSelect={handleAgentSelect}
        onProjectSelect={handleProjectSelect}
        onSpawnClick={handleSpawnClick}
        onTaskCreate={handleTaskCreate}
        onGeneralClick={() => {
          selectAgent(null);
          setCurrentChannel('general');
        }}
      />

      {/* Spawn Modal */}
      <SpawnModal
        isOpen={isSpawnModalOpen}
        onClose={() => setIsSpawnModalOpen(false)}
        onSpawn={handleSpawn}
        existingAgents={agents.map((a) => a.name)}
        isSpawning={isSpawning}
        error={spawnError}
      />

      {/* Settings Panel */}
      <SettingsPanel
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
        onResetSettings={() => setSettings(defaultSettings)}
      />

      {/* Add Workspace Modal */}
      <AddWorkspaceModal
        isOpen={isAddWorkspaceOpen}
        onClose={() => {
          setIsAddWorkspaceOpen(false);
          setAddWorkspaceError(null);
        }}
        onAdd={handleAddWorkspace}
        isAdding={isAddingWorkspace}
        error={addWorkspaceError}
      />

      {/* Conversation History */}
      <ConversationHistory
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
      />

      {/* New Conversation Modal */}
      <NewConversationModal
        isOpen={isNewConversationOpen}
        onClose={() => setIsNewConversationOpen(false)}
        onSend={handleNewConversationSend}
        agents={agents}
        isSending={isSending}
        error={sendError}
      />

      {/* Log Viewer Panel */}
      {logViewerAgent && (
        <LogViewerPanel
          agent={logViewerAgent}
          isOpen={true}
          onClose={() => setLogViewerAgent(null)}
          availableAgents={agents}
          onAgentChange={setLogViewerAgent}
        />
      )}

      {/* Trajectory Panel - Fullscreen slide-over */}
      {isTrajectoryOpen && (
        <div
          className="fixed inset-0 z-50 flex bg-black/50 backdrop-blur-sm"
          onClick={() => setIsTrajectoryOpen(false)}
        >
          <div
            className="ml-auto w-full max-w-3xl h-full bg-bg-primary shadow-2xl animate-in slide-in-from-right duration-300 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle bg-bg-secondary">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-accent-cyan/20 flex items-center justify-center border border-blue-500/30">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-blue-500">
                    <path d="M3 12h4l3 9 4-18 3 9h4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-text-primary m-0">Trajectory Viewer</h2>
                  <p className="text-xs text-text-muted m-0">
                    {trajectoryStatus?.active ? `Active: ${trajectoryStatus.task || 'Working...'}` : 'Browse past trajectories'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsTrajectoryOpen(false)}
                className="w-10 h-10 rounded-lg bg-bg-tertiary border border-border-subtle flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover hover:border-blue-500/50 transition-all"
                title="Close (Esc)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden p-6">
              <TrajectoryViewer
                agentName={trajectoryStatus?.task?.slice(0, 30) || 'Current'}
                steps={trajectorySteps}
                history={trajectoryHistory}
                selectedTrajectoryId={selectedTrajectoryId}
                onSelectTrajectory={selectTrajectory}
                isLoading={isTrajectoryLoading}
                maxHeight="calc(100vh - 160px)"
              />
            </div>
          </div>
        </div>
      )}


      {/* Decision Queue Panel */}
      {isDecisionQueueOpen && (
        <div className="fixed left-4 bottom-4 w-[400px] max-h-[500px] z-50 shadow-modal">
          <div className="relative">
            <button
              onClick={() => setIsDecisionQueueOpen(false)}
              className="absolute -top-2 -right-2 w-6 h-6 bg-bg-elevated border border-border rounded-full flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover z-10"
              title="Close decisions"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
            <DecisionQueue
              decisions={decisions}
              onApprove={handleDecisionApprove}
              onReject={handleDecisionReject}
              onDismiss={handleDecisionDismiss}
              isProcessing={decisionProcessing}
            />
          </div>
        </div>
      )}

      {/* Decision Queue Toggle Button (bottom-left when panel is closed) */}
      {!isDecisionQueueOpen && decisions.length > 0 && (
        <button
          onClick={() => setIsDecisionQueueOpen(true)}
          className="fixed left-4 bottom-4 w-12 h-12 bg-warning text-bg-deep rounded-full shadow-[0_0_20px_rgba(255,107,53,0.4)] flex items-center justify-center hover:scale-105 transition-transform z-50"
          title={`${decisions.length} pending decision${decisions.length > 1 ? 's' : ''}`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {decisions.length > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-error text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {decisions.length}
            </span>
          )}
        </button>
      )}

      {/* User Profile Panel */}
      <UserProfilePanel
        user={selectedUserProfile}
        onClose={() => setSelectedUserProfile(null)}
        onMention={(username) => {
          // TODO: Focus composer and insert @username
          // For now, just close the panel
          setSelectedUserProfile(null);
        }}
      />

      {/* Coordinator Panel */}
      <CoordinatorPanel
        isOpen={isCoordinatorOpen}
        onClose={() => setIsCoordinatorOpen(false)}
        projects={mergedProjects}
        isCloudMode={!!currentUser}
        hasArchitect={bridgeAgents.some(a => a.name.toLowerCase() === 'architect')}
        onArchitectSpawned={() => {
          // Architect will appear via WebSocket update
          setIsCoordinatorOpen(false);
        }}
      />
    </div>
  );
}

/**
 * Pending attachment interface for UI state
 */
interface PendingAttachment {
  id: string;
  file: File;
  preview: string;
  isUploading: boolean;
  uploadedId?: string;
  error?: string;
}

/**
 * Message Composer Component with @-mention autocomplete and image attachments
 */
interface MessageComposerProps {
  recipient: string;
  agents: Agent[];
  humanUsers: HumanUser[];
  onSend: (to: string, content: string, thread?: string, attachmentIds?: string[]) => Promise<boolean>;
  onTyping?: (isTyping: boolean) => void;
  isSending: boolean;
  error: string | null;
}

function MessageComposer({ recipient, agents, humanUsers, onSend, onTyping, isSending, error }: MessageComposerProps) {
  const [message, setMessage] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [showMentions, setShowMentions] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Process image files (used by both paste and file input)
  const processImageFiles = useCallback(async (imageFiles: File[]) => {
    for (const file of imageFiles) {
      const id = crypto.randomUUID();
      const preview = URL.createObjectURL(file);

      // Add to pending attachments
      setAttachments(prev => [...prev, {
        id,
        file,
        preview,
        isUploading: true,
      }]);

      // Upload the file
      try {
        const result = await api.uploadAttachment(file);
        if (result.success && result.data) {
          setAttachments(prev => prev.map(a =>
            a.id === id
              ? { ...a, isUploading: false, uploadedId: result.data!.attachment.id }
              : a
          ));
        } else {
          setAttachments(prev => prev.map(a =>
            a.id === id
              ? { ...a, isUploading: false, error: result.error || 'Upload failed' }
              : a
          ));
        }
      } catch (err) {
        setAttachments(prev => prev.map(a =>
          a.id === id
            ? { ...a, isUploading: false, error: 'Upload failed' }
            : a
        ));
      }
    }
  }, []);

  // Handle file selection from file input
  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;

    const imageFiles = Array.from(files).filter(file =>
      file.type.startsWith('image/')
    );

    if (imageFiles.length > 0) {
      processImageFiles(imageFiles);
    }
  }, [processImageFiles]);

  // Handle paste for clipboard images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    // Collect image files from both sources
    let imageFiles: File[] = [];

    // Method 1: Check clipboardData.files (works for file pastes)
    if (clipboardData.files && clipboardData.files.length > 0) {
      imageFiles = Array.from(clipboardData.files).filter(file =>
        file.type.startsWith('image/')
      );
    }

    // Method 2: Check clipboardData.items (works for screenshots/copied images)
    // This is the primary method for pasted images from clipboard
    if (imageFiles.length === 0 && clipboardData.items) {
      const items = Array.from(clipboardData.items);
      for (const item of items) {
        // Check if this item is an image
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
    }

    // Process any found images
    if (imageFiles.length > 0) {
      e.preventDefault();
      processImageFiles(imageFiles);
    }
  }, [processImageFiles]);

  // Remove an attachment
  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const attachment = prev.find(a => a.id === id);
      if (attachment) {
        URL.revokeObjectURL(attachment.preview);
      }
      return prev.filter(a => a.id !== id);
    });
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setMessage(value);
    setCursorPosition(cursorPos);

    // Send typing indicator when user has content
    onTyping?.(value.trim().length > 0);

    // Check for file autocomplete first (@ followed by path-like pattern)
    const fileQuery = getFileQuery(value, cursorPos);
    if (fileQuery !== null) {
      setShowFiles(true);
      setShowMentions(false);
      return;
    }

    // Check for mention autocomplete (@ at start without path patterns)
    const mentionQuery = getMentionQuery(value, cursorPos);
    if (mentionQuery !== null) {
      setShowMentions(true);
      setShowFiles(false);
      return;
    }

    // Neither - hide both
    setShowMentions(false);
    setShowFiles(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't handle Enter/Tab when autocomplete is visible (let autocomplete handle it)
    if ((showMentions || showFiles) && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab')) {
      return; // Let the autocomplete component handle these keys
    }

    if (e.key === 'Enter' && !e.shiftKey && !showMentions && !showFiles) {
      e.preventDefault();
      if ((message.trim() || attachments.length > 0) && !isSending) {
        handleSubmit(e as unknown as React.FormEvent);
      }
    }
  };

  const handleMentionSelect = (mention: string, newValue: string) => {
    setMessage(newValue);
    setShowMentions(false);
    setShowFiles(false);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const pos = newValue.indexOf(' ') + 1;
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleFilePathSelect = (filePath: string, newValue: string) => {
    setMessage(newValue);
    setShowFiles(false);
    setShowMentions(false);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const pos = newValue.indexOf(' ', 1) + 1; // After @path/to/file<space>
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Need either message or attachments
    const hasMessage = message.trim().length > 0;
    const hasAttachments = attachments.length > 0;
    if ((!hasMessage && !hasAttachments) || isSending) return;

    // Check if any attachments are still uploading
    const stillUploading = attachments.some(a => a.isUploading);
    if (stillUploading) return;

    // Get uploaded attachment IDs
    const attachmentIds = attachments
      .filter(a => a.uploadedId)
      .map(a => a.uploadedId!);

    const mentionMatch = message.match(/^@(\S+)\s*([\s\S]*)/);
    let target: string;
    let content: string;

    if (mentionMatch) {
      const mentionedName = mentionMatch[1];
      content = mentionMatch[2] || '';

      if (mentionedName === '*' || mentionedName.toLowerCase() === 'everyone' || mentionedName.toLowerCase() === 'all') {
        target = '*';
      } else if (mentionedName.toLowerCase().startsWith('team:')) {
        // Team mention - pass through to backend (e.g., team:frontend)
        target = mentionedName;
      } else {
        // Check if this is a file path mention (contains / or ends with common file extensions)
        // If so, keep the full message as content and use default recipient
        if (mentionedName.includes('/') || /\.(ts|tsx|js|jsx|json|md|py|go|rs|java|c|cpp|h|css|html|yaml|yml|toml)$/i.test(mentionedName)) {
          target = recipient;
          content = message; // Keep the @path/to/file in the message
        } else {
          target = mentionedName;
        }
      }
    } else {
      target = recipient;
      content = message;
    }

    // If no message but has attachments, send with default text
    if (!content.trim() && attachmentIds.length > 0) {
      content = '[Screenshot attached]';
    }

    const success = await onSend(
      target,
      content || message,
      undefined,
      attachmentIds.length > 0 ? attachmentIds : undefined
    );

    if (success) {
      // Clean up previews
      attachments.forEach(a => URL.revokeObjectURL(a.preview));
      setMessage('');
      setAttachments([]);
      setShowMentions(false);
      setShowFiles(false);
    }
  };

  // Check if we can send (have content or attachments, not uploading)
  const canSend = (message.trim() || attachments.length > 0) &&
    !isSending &&
    !attachments.some(a => a.isUploading);

  return (
    <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 p-2 bg-bg-card rounded-lg border border-border-subtle">
          {attachments.map(attachment => (
            <div
              key={attachment.id}
              className="relative group"
            >
              <img
                src={attachment.preview}
                alt={attachment.file.name}
                className={`h-16 w-auto rounded-lg object-cover ${attachment.isUploading ? 'opacity-50' : ''} ${attachment.error ? 'border-2 border-error' : ''}`}
              />
              {attachment.isUploading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg className="animate-spin h-5 w-5 text-accent-cyan" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="32" strokeLinecap="round" />
                  </svg>
                </div>
              )}
              {attachment.error && (
                <div className="absolute bottom-0 left-0 right-0 bg-error/90 text-white text-[10px] px-1 py-0.5 truncate">
                  {attachment.error}
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-bg-tertiary border border-border-subtle rounded-full flex items-center justify-center text-text-muted hover:text-error hover:border-error transition-colors opacity-0 group-hover:opacity-100"
                title="Remove"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-center gap-3">
        {/* Image upload button */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFileSelect(e.target.files)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="p-2.5 bg-bg-card border border-border-subtle rounded-xl text-text-muted hover:text-accent-cyan hover:border-accent-cyan/50 transition-colors"
          title="Attach screenshot (or paste from clipboard)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>

        <div className="flex-1 relative">
          {/* Agent mention autocomplete */}
          <MentionAutocomplete
            agents={agents}
            humanUsers={humanUsers}
            inputValue={message}
            cursorPosition={cursorPosition}
            onSelect={handleMentionSelect}
            onClose={() => setShowMentions(false)}
            isVisible={showMentions}
          />
          {/* File path autocomplete */}
          <FileAutocomplete
            inputValue={message}
            cursorPosition={cursorPosition}
            onSelect={handleFilePathSelect}
            onClose={() => setShowFiles(false)}
            isVisible={showFiles}
          />
          <textarea
            ref={textareaRef}
            className="w-full py-3 px-4 bg-bg-card border border-border-subtle rounded-xl text-sm font-sans text-text-primary outline-none transition-all duration-200 resize-none min-h-[44px] max-h-[120px] overflow-y-auto focus:border-accent-cyan/50 focus:shadow-[0_0_0_3px_rgba(0,217,255,0.1)] placeholder:text-text-muted"
            placeholder={`Message ${recipient === '*' ? 'everyone' : '@' + recipient}... (@ for agents/files)`}
            value={message}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onSelect={(e) => setCursorPosition((e.target as HTMLTextAreaElement).selectionStart || 0)}
            disabled={isSending}
            rows={1}
          />
        </div>
        <button
          type="submit"
          className="py-3 px-5 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold border-none rounded-xl text-sm cursor-pointer transition-all duration-150 hover:shadow-glow-cyan hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
          disabled={!canSend}
          title={isSending ? 'Sending...' : attachments.some(a => a.isUploading) ? 'Uploading...' : 'Send message'}
        >
          {isSending ? (
            <span>Sending...</span>
          ) : attachments.some(a => a.isUploading) ? (
            <span>Uploading...</span>
          ) : (
            <span className="flex items-center gap-2">
              Send
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </span>
          )}
        </button>
        {error && <span className="text-error text-xs ml-2">{error}</span>}
      </div>
    </form>
  );
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin mb-4 text-accent-cyan" width="28" height="28" viewBox="0 0 24 24">
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

function ErrorIcon() {
  return (
    <svg className="text-error mb-4" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/**
 * Legacy CSS styles export - kept for backwards compatibility
 * @deprecated Use Tailwind classes directly instead
 */
export const appStyles = '';
