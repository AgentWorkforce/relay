/**
 * Dashboard V2 - Main Application Component
 *
 * Root component that combines sidebar, header, and main content area.
 * Manages global state via hooks and provides context to child components.
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Agent, Project, Message, AgentSummary, ActivityEvent } from '../types';
import { ActivityFeed } from './ActivityFeed';
import { Sidebar } from './layout/Sidebar';
import { Header } from './layout/Header';
import { MessageList } from './MessageList';
import { ThreadPanel } from './ThreadPanel';
import { CommandPalette, type TaskCreateRequest, PRIORITY_CONFIG } from './CommandPalette';
import { SpawnModal, type SpawnConfig } from './SpawnModal';
import { NewConversationModal } from './NewConversationModal';
import { SettingsPage, defaultSettings, type Settings } from './settings';
import { ConversationHistory } from './ConversationHistory';
import type { HumanUser } from './MentionAutocomplete';
import { NotificationToast, useToasts } from './NotificationToast';
import { WorkspaceSelector, type Workspace } from './WorkspaceSelector';
import { AddWorkspaceModal } from './AddWorkspaceModal';
import { LogViewerPanel } from './LogViewerPanel';
import { TrajectoryViewer } from './TrajectoryViewer';
import { DecisionQueue, type Decision } from './DecisionQueue';
import { FleetOverview } from './FleetOverview';
import type { ServerInfo } from './ServerCard';
import { TypingIndicator } from './TypingIndicator';
import { MessageComposer } from './MessageComposer';
import { OnlineUsersIndicator } from './OnlineUsersIndicator';
import { UserProfilePanel } from './UserProfilePanel';
import { AgentProfilePanel } from './AgentProfilePanel';
import { useDirectMessage } from './hooks/useDirectMessage';
import { CoordinatorPanel } from './CoordinatorPanel';
import { BillingResult } from './BillingResult';
import { UsageBanner } from './UsageBanner';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgents } from './hooks/useAgents';
import { useMessages } from './hooks/useMessages';
import { useOrchestrator } from './hooks/useOrchestrator';
import { useTrajectory } from './hooks/useTrajectory';
import { useRecentRepos } from './hooks/useRecentRepos';
import { useWorkspaceRepos } from './hooks/useWorkspaceRepos';
import { usePresence, type UserPresence } from './hooks/usePresence';
import {
  ChannelViewV1,
  SearchInput,
  CreateChannelModal,
  InviteToChannelModal,
  MemberManagementPanel,
  listChannels,
  getMessages,
  getChannelMembers,
  removeMember as removeChannelMember,
  sendMessage as sendChannelApiMessage,
  markRead,
  createChannel,
  type Channel,
  type ChannelMember,
  type ChannelMessage as ChannelApiMessage,
  type UnreadState,
  type CreateChannelRequest,
} from './channels';
import { useWorkspaceMembers, filterOnlineUsersByWorkspace } from './hooks/useWorkspaceMembers';
import { useCloudSessionOptional } from './CloudSessionProvider';
import { WorkspaceProvider } from './WorkspaceContext';
import { api, convertApiDecision, setActiveWorkspaceId as setApiWorkspaceId, getActiveWorkspaceId, getCsrfToken } from '../lib/api';
import { cloudApi } from '../lib/cloudApi';
import { mergeAgentsForDashboard } from '../lib/agent-merge';
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

const SETTINGS_STORAGE_KEY = 'dashboard-settings';

/** Special ID for the Activity feed (broadcasts) */
export const ACTIVITY_FEED_ID = '__activity__';

type LegacyDashboardSettings = {
  theme?: 'dark' | 'light' | 'system';
  compactMode?: boolean;
  showTimestamps?: boolean;
  soundEnabled?: boolean;
  notificationsEnabled?: boolean;
  autoScrollMessages?: boolean;
};

function mergeSettings(base: Settings, partial: Partial<Settings>): Settings {
  return {
    ...base,
    ...partial,
    notifications: { ...base.notifications, ...partial.notifications },
    display: { ...base.display, ...partial.display },
    messages: { ...base.messages, ...partial.messages },
    connection: { ...base.connection, ...partial.connection },
  };
}

function migrateLegacySettings(raw: LegacyDashboardSettings): Settings {
  const theme = raw.theme && ['dark', 'light', 'system'].includes(raw.theme)
    ? raw.theme
    : defaultSettings.theme;
  const sound = raw.soundEnabled ?? defaultSettings.notifications.sound;
  const desktop = raw.notificationsEnabled ?? defaultSettings.notifications.desktop;
  return {
    ...defaultSettings,
    theme,
    display: {
      ...defaultSettings.display,
      compactMode: raw.compactMode ?? defaultSettings.display.compactMode,
      showTimestamps: raw.showTimestamps ?? defaultSettings.display.showTimestamps,
    },
    notifications: {
      ...defaultSettings.notifications,
      sound,
      desktop,
      enabled: sound || desktop || defaultSettings.notifications.mentionsOnly,
    },
    messages: {
      ...defaultSettings.messages,
      autoScroll: raw.autoScrollMessages ?? defaultSettings.messages.autoScroll,
    },
  };
}

function loadSettingsFromStorage(): Settings {
  if (typeof window === 'undefined') return defaultSettings;
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!saved) return defaultSettings;
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== 'object') return defaultSettings;
    if ('notifications' in parsed && 'display' in parsed) {
      const merged = mergeSettings(defaultSettings, parsed as Partial<Settings>);
      merged.notifications.enabled = merged.notifications.sound ||
        merged.notifications.desktop ||
        merged.notifications.mentionsOnly;
      return merged;
    }
    if ('notificationsEnabled' in parsed || 'soundEnabled' in parsed || 'autoScrollMessages' in parsed) {
      return migrateLegacySettings(parsed as LegacyDashboardSettings);
    }
  } catch {
    // Fall back to defaults
  }
  return defaultSettings;
}

function saveSettingsToStorage(settings: Settings) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore localStorage failures
  }
}

function playNotificationSound() {
  if (typeof window === 'undefined') return;
  const AudioContextConstructor =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    const context = new AudioContextConstructor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.03;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    oscillator.onended = () => {
      context.close().catch(() => undefined);
    };
  } catch {
    // Audio might be blocked by browser autoplay policies
  }
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

  // Cloud workspaces state (for cloud mode)
  // Includes owned, member, and contributor workspaces (via GitHub repo access)
  const [cloudWorkspaces, setCloudWorkspaces] = useState<Array<{
    id: string;
    name: string;
    status: string;
    publicUrl?: string;
    accessType?: 'owner' | 'member' | 'contributor';
    permission?: 'admin' | 'write' | 'read';
  }>>([]);
  // Initialize from API module if already set (e.g., by DashboardPage when connecting to workspace)
  const [activeCloudWorkspaceId, setActiveCloudWorkspaceId] = useState<string | null>(() => getActiveWorkspaceId());
  const [isLoadingCloudWorkspaces, setIsLoadingCloudWorkspaces] = useState(false);

  // Local agents from linked daemons
  const [localAgents, setLocalAgents] = useState<Agent[]>([]);

  // Fetch cloud workspaces when in cloud mode
  // Uses getAccessibleWorkspaces to include contributor workspaces (via GitHub repos)
  useEffect(() => {
    if (!cloudSession?.user) return;

    const fetchCloudWorkspaces = async () => {
      setIsLoadingCloudWorkspaces(true);
      try {
        const result = await cloudApi.getAccessibleWorkspaces();
        if (result.success && result.data.workspaces) {
          setCloudWorkspaces(result.data.workspaces);
          const workspaceIds = new Set(result.data.workspaces.map(w => w.id));
          // Validate current selection exists, or auto-select first workspace
          if (activeCloudWorkspaceId && !workspaceIds.has(activeCloudWorkspaceId)) {
            // Current workspace no longer exists, clear selection to trigger auto-select
            if (result.data.workspaces.length > 0) {
              const firstWorkspaceId = result.data.workspaces[0].id;
              setActiveCloudWorkspaceId(firstWorkspaceId);
              setApiWorkspaceId(firstWorkspaceId);
            } else {
              setActiveCloudWorkspaceId(null);
              setApiWorkspaceId(null);
            }
          } else if (!activeCloudWorkspaceId && result.data.workspaces.length > 0) {
            // No selection yet, auto-select first workspace
            const firstWorkspaceId = result.data.workspaces[0].id;
            setActiveCloudWorkspaceId(firstWorkspaceId);
            // Sync immediately with api module to avoid race conditions
            setApiWorkspaceId(firstWorkspaceId);
          }
        }
      } catch (err) {
        console.error('Failed to fetch cloud workspaces:', err);
      } finally {
        setIsLoadingCloudWorkspaces(false);
      }
    };

    fetchCloudWorkspaces();
    // Poll for updates every 30 seconds
    const interval = setInterval(fetchCloudWorkspaces, 30000);
    return () => clearInterval(interval);
  }, [cloudSession?.user, activeCloudWorkspaceId]);

  // Fetch local agents for the active workspace
  useEffect(() => {
    if (!cloudSession?.user || !activeCloudWorkspaceId) {
      setLocalAgents([]);
      return;
    }

    const fetchLocalAgents = async () => {
      try {
        const result = await api.get<{
          agents: Array<{
            name: string;
            status: string;
            isLocal: boolean;
            isHuman?: boolean;
            avatarUrl?: string;
            daemonId: string;
            daemonName: string;
            daemonStatus: string;
            machineId: string;
            lastSeenAt: string | null;
          }>;
        }>(`/api/daemons/workspace/${activeCloudWorkspaceId}/agents`);

        if (result.agents) {
          // Convert API response to Agent format
          // Agent status is 'online' when daemon is online (agent is connected to daemon)
          const agents: Agent[] = result.agents.map((a) => ({
            name: a.name,
            status: a.daemonStatus === 'online' ? 'online' : 'offline',
            // Only mark AI agents as "local" (from linked daemon), not human users
            isLocal: !a.isHuman,
            isHuman: a.isHuman,
            avatarUrl: a.avatarUrl,
            // Don't include daemon info for human users
            daemonName: a.isHuman ? undefined : a.daemonName,
            machineId: a.isHuman ? undefined : a.machineId,
            lastSeen: a.lastSeenAt || undefined,
          }));
          setLocalAgents(agents);
        }
      } catch (err) {
        console.error('Failed to fetch local agents:', err);
        setLocalAgents([]);
      }
    };

    fetchLocalAgents();
    // Poll for updates every 15 seconds
    const interval = setInterval(fetchLocalAgents, 15000);
    return () => clearInterval(interval);
  }, [cloudSession?.user, activeCloudWorkspaceId]);

  // Determine which workspaces to use (cloud mode or orchestrator)
  const isCloudMode = Boolean(cloudSession?.user);
  const effectiveWorkspaces = useMemo(() => {
    if (isCloudMode && cloudWorkspaces.length > 0) {
      // Convert cloud workspaces to the format expected by WorkspaceSelector
      // Includes owned, member, and contributor workspaces
      return cloudWorkspaces.map(ws => ({
        id: ws.id,
        name: ws.name,
        path: ws.publicUrl || `/workspace/${ws.name}`,
        status: ws.status === 'running' ? 'active' as const : 'inactive' as const,
        provider: 'claude' as const,
        lastActiveAt: new Date(),
      }));
    }
    return workspaces;
  }, [isCloudMode, cloudWorkspaces, workspaces]);

  const effectiveActiveWorkspaceId = isCloudMode ? activeCloudWorkspaceId : activeWorkspaceId;
  const effectiveIsLoading = isCloudMode ? isLoadingCloudWorkspaces : isOrchestratorLoading;

  // Sync the active workspace ID with the api module for cloud mode proxying
  // This useEffect serves as a safeguard and handles initial load/edge cases
  // The immediate sync in handleEffectiveWorkspaceSelect handles user-initiated changes
  useEffect(() => {
    if (isCloudMode && activeCloudWorkspaceId) {
      setApiWorkspaceId(activeCloudWorkspaceId);
    } else if (isCloudMode && !activeCloudWorkspaceId) {
      // In cloud mode but no workspace selected - clear the proxy
      setApiWorkspaceId(null);
    } else if (!isCloudMode) {
      // Clear the workspace ID when not in cloud mode
      setApiWorkspaceId(null);
    }
  }, [isCloudMode, activeCloudWorkspaceId]);

  // Handle workspace selection (works for both cloud and orchestrator)
  const handleEffectiveWorkspaceSelect = useCallback(async (workspace: { id: string; name: string }) => {
    if (isCloudMode) {
      setActiveCloudWorkspaceId(workspace.id);
      // Sync immediately with api module to avoid race conditions
      // This ensures spawn/release calls use the correct workspace before the useEffect runs
      setApiWorkspaceId(workspace.id);
    } else {
      await switchWorkspace(workspace.id);
    }
  }, [isCloudMode, switchWorkspace]);

  // Presence tracking for online users and typing indicators
  // Memoize the user object to prevent reconnection on every render
  const presenceUser = useMemo(() =>
    currentUser
      ? { username: currentUser.displayName, avatarUrl: currentUser.avatarUrl }
      : undefined,
    [currentUser?.displayName, currentUser?.avatarUrl]
  );

  // Channel state: selectedChannelId must be declared before callbacks that use it
  // Default to Activity feed on load
  const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>(ACTIVITY_FEED_ID);

  // Activity feed state - unified timeline of workspace events
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);

  // Helper to add activity events
  const addActivityEvent = useCallback((event: Omit<ActivityEvent, 'id' | 'timestamp'>) => {
    const newEvent: ActivityEvent = {
      ...event,
      id: `activity-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    setActivityEvents(prev => [newEvent, ...prev].slice(0, 200)); // Keep last 200 events
  }, []);

  // Member management state
  const [showMemberPanel, setShowMemberPanel] = useState(false);
  const [channelMembers, setChannelMembers] = useState<ChannelMember[]>([]);

  const appendChannelMessage = useCallback((channelId: string, message: ChannelApiMessage, options?: { incrementUnread?: boolean }) => {
    const incrementUnread = options?.incrementUnread ?? true;

    setChannelMessageMap(prev => {
      const list = prev[channelId] ?? [];
      const isDuplicate = list.some((m) => {
        if (m.id === message.id) return true;
        if (m.from !== message.from) return false;
        if (m.content !== message.content) return false;
        if (m.threadId !== message.threadId) return false;
        const timeDiff = Math.abs(new Date(m.timestamp).getTime() - new Date(message.timestamp).getTime());
        return timeDiff < 2000;
      });
      if (isDuplicate) return prev;
      return { ...prev, [channelId]: [...list, message] };
    });

    if (selectedChannelId === channelId) {
      setChannelMessages(prev => [...prev, message]);
      setChannelUnreadState(undefined);
    } else if (incrementUnread) {
      setChannelsList(prev => {
        const existing = prev.find(c => c.id === channelId);
        if (existing) {
          return prev.map(c =>
            c.id === channelId
              ? { ...c, unreadCount: (c.unreadCount ?? 0) + 1 }
              : c
          );
        }

        const newChannel: Channel = {
          id: channelId,
          name: channelId.startsWith('#') ? channelId.slice(1) : channelId,
          visibility: 'public',
          status: 'active',
          createdAt: new Date().toISOString(),
          createdBy: currentUser?.displayName || 'Dashboard',
          memberCount: 1,
          unreadCount: 1,
          hasMentions: false,
          isDm: channelId.startsWith('dm:'),
        };

        return [...prev, newChannel];
      });
    }
  }, [currentUser?.displayName, selectedChannelId]);

  const handlePresenceEvent = useCallback((event: any) => {
    // Activity feed: capture presence join/leave events
    if (event?.type === 'presence_join' && event.user) {
      const user = event.user;
      // Skip self
      if (user.username !== currentUser?.displayName) {
        addActivityEvent({
          type: 'user_joined',
          actor: user.username,
          actorAvatarUrl: user.avatarUrl,
          actorType: 'user',
          title: 'came online',
        });
      }
    } else if (event?.type === 'presence_leave' && event.username) {
      // Skip self
      if (event.username !== currentUser?.displayName) {
        addActivityEvent({
          type: 'user_left',
          actor: event.username,
          actorType: 'user',
          title: 'went offline',
        });
      }
    } else if (event?.type === 'agent_spawned' && event.agent) {
      // Agent spawned event from backend
      addActivityEvent({
        type: 'agent_spawned',
        actor: event.agent.name || event.agent,
        actorType: 'agent',
        title: 'was spawned',
        description: event.task,
        metadata: { cli: event.cli, task: event.task, spawnedBy: event.spawnedBy },
      });
    } else if (event?.type === 'agent_released' && event.agent) {
      // Agent released event from backend
      addActivityEvent({
        type: 'agent_released',
        actor: event.agent.name || event.agent,
        actorType: 'agent',
        title: 'was released',
        metadata: { releasedBy: event.releasedBy },
      });
    } else if (event?.type === 'channel_created') {
      // Another user created a channel - add it to the list
      const newChannel = event.channel;
      if (!newChannel || !newChannel.id) return;

      setChannelsList(prev => {
        // Don't add if already exists
        if (prev.some(c => c.id === newChannel.id)) return prev;

        const channel: Channel = {
          id: newChannel.id,
          name: newChannel.name || newChannel.id,
          description: newChannel.description,
          visibility: newChannel.visibility || 'public',
          status: newChannel.status || 'active',
          createdAt: newChannel.createdAt || new Date().toISOString(),
          createdBy: newChannel.createdBy || 'unknown',
          memberCount: newChannel.memberCount || 1,
          unreadCount: newChannel.unreadCount || 0,
          hasMentions: newChannel.hasMentions || false,
          isDm: newChannel.isDm || false,
        };
        console.log('[App] Channel created via WebSocket:', channel.id);
        return [...prev, channel];
      });
    } else if (event?.type === 'channel_message') {
      const channelId = event.channel as string | undefined;
      if (!channelId) return;
      const sender = event.from || 'unknown';
      // Use server-provided entity type if available, otherwise derive locally
      const fromEntityType = event.fromEntityType || (currentUser?.displayName && sender === currentUser.displayName ? 'user' : 'agent');
      const msg: ChannelApiMessage = {
        id: event.id ?? `ws-${Date.now()}`,
        channelId,
        from: sender,
        fromEntityType,
        fromAvatarUrl: event.fromAvatarUrl,
        content: event.body ?? '',
        timestamp: event.timestamp || new Date().toISOString(),
        threadId: event.thread,
        isRead: selectedChannelId === channelId,
      };
      appendChannelMessage(channelId, msg, { incrementUnread: selectedChannelId !== channelId });
    } else if (event?.type === 'direct_message') {
      // Handle direct messages sent to the user's GitHub username
      const sender = event.from || 'unknown';
      const recipient = currentUser?.displayName;
      if (!recipient) return;

      // Create DM channel ID with sorted participants for consistency
      const participants = [sender, recipient].sort();
      const dmChannelId = `dm:${participants.join(':')}`;

      // Use server-provided entity type if available
      const fromEntityType = event.fromEntityType || 'agent';
      const msg: ChannelApiMessage = {
        id: event.id ?? `dm-${Date.now()}`,
        channelId: dmChannelId,
        from: sender,
        fromEntityType,
        fromAvatarUrl: event.fromAvatarUrl,
        content: event.body ?? '',
        timestamp: event.timestamp || new Date().toISOString(),
        threadId: event.thread,
        isRead: selectedChannelId === dmChannelId,
      };
      appendChannelMessage(dmChannelId, msg, { incrementUnread: selectedChannelId !== dmChannelId });
    }
  }, [addActivityEvent, appendChannelMessage, currentUser?.displayName, selectedChannelId]);

  const { onlineUsers: allOnlineUsers, typingUsers, sendTyping, isConnected: isPresenceConnected } = usePresence({
    currentUser: presenceUser,
    onEvent: handlePresenceEvent,
    workspaceId: effectiveActiveWorkspaceId ?? undefined,
  });

  // Keep local username for channel API calls
  useEffect(() => {
    if (typeof window !== 'undefined' && currentUser?.displayName) {
      localStorage.setItem('relay_username', currentUser.displayName);
    }
  }, [currentUser?.displayName]);

  // Filter online users by workspace membership (cloud mode only)
  const { memberUsernames } = useWorkspaceMembers({
    workspaceId: effectiveActiveWorkspaceId ?? undefined,
    enabled: isCloudMode && !!effectiveActiveWorkspaceId,
  });

  // Filter online users to only show those with access to current workspace
  const onlineUsers = useMemo(
    () => filterOnlineUsersByWorkspace(allOnlineUsers, memberUsernames),
    [allOnlineUsers, memberUsernames]
  );

  // User profile panel state
  const [selectedUserProfile, setSelectedUserProfile] = useState<UserPresence | null>(null);
  const [pendingMention, setPendingMention] = useState<string | undefined>();

  // Agent profile panel state
  const [selectedAgentProfile, setSelectedAgentProfile] = useState<Agent | null>(null);

  // Agent summaries lookup
  const agentSummariesMap = useMemo(() => {
    const map = new Map<string, AgentSummary>();
    for (const summary of data?.summaries ?? []) {
      map.set(summary.agentName.toLowerCase(), summary);
    }
    return map;
  }, [data?.summaries]);

  // View mode state: 'local' (agents), 'fleet' (multi-server), 'channels' (channel messaging)
  const [viewMode, setViewMode] = useState<'local' | 'fleet' | 'channels'>('local');

  // Channel state for V1 channels UI
  const [channelsList, setChannelsList] = useState<Channel[]>([]);
  const [archivedChannelsList, setArchivedChannelsList] = useState<Channel[]>([]);
  const [channelMessages, setChannelMessages] = useState<ChannelApiMessage[]>([]);
  const [channelMessageMap, setChannelMessageMap] = useState<Record<string, ChannelApiMessage[]>>({});
  const fetchedChannelsRef = useRef<Set<string>>(new Set()); // Track channels already fetched to prevent loops
  const [isChannelsLoading, setIsChannelsLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [channelUnreadState, setChannelUnreadState] = useState<UnreadState | undefined>();

  // Default channel IDs that should always be visible
  const DEFAULT_CHANNEL_IDS = ['#general', '#engineering'];

  const setChannelListsFromResponse = useCallback((response: { channels: Channel[]; archivedChannels?: Channel[] }) => {
    const archived = [
      ...(response.archivedChannels || []),
      ...response.channels.filter(c => c.status === 'archived'),
    ];
    const apiActive = response.channels.filter(c => c.status !== 'archived');

    // Merge with default channels to ensure #general is always visible
    // Default channels are added if not present in API response
    const apiChannelIds = new Set(apiActive.map(c => c.id));
    const defaultChannelsToAdd: Channel[] = DEFAULT_CHANNEL_IDS
      .filter(id => !apiChannelIds.has(id))
      .map(id => ({
        id,
        name: id.replace('#', ''),
        description: id === '#general' ? 'General discussion for all agents' : 'Engineering discussion',
        visibility: 'public' as const,
        memberCount: 0,
        unreadCount: 0,
        hasMentions: false,
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        createdBy: 'system',
        isDm: false,
      }));

    setChannelsList([...defaultChannelsToAdd, ...apiActive]);
    setArchivedChannelsList(archived);
  }, []);

  // Find selected channel object
  const selectedChannel = useMemo(() => {
    if (!selectedChannelId) return undefined;
    return channelsList.find(c => c.id === selectedChannelId) ||
           archivedChannelsList.find(c => c.id === selectedChannelId);
  }, [selectedChannelId, channelsList, archivedChannelsList]);

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

  // Create channel modal state
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false);
  const [isCreatingChannel, setIsCreatingChannel] = useState(false);

  // Invite to channel modal state
  const [isInviteChannelOpen, setIsInviteChannelOpen] = useState(false);
  const [inviteChannelTarget, setInviteChannelTarget] = useState<Channel | null>(null);
  const [isInvitingToChannel, setIsInvitingToChannel] = useState(false);

  // Command palette state
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

  // Settings state (theme, display, notifications)
  const [settings, setSettings] = useState<Settings>(() => loadSettingsFromStorage());
  const updateSettings = useCallback((updater: (prev: Settings) => Settings) => {
    setSettings((prev) => updater(prev));
  }, []);

  // Full settings page state
  const [isFullSettingsOpen, setIsFullSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'dashboard' | 'workspace' | 'team' | 'billing'>('dashboard');

  // Conversation history panel state
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // New conversation modal state
  const [isNewConversationOpen, setIsNewConversationOpen] = useState(false);

  // DM participant selections (human -> invited agents) and removals
  const [dmSelectedAgentsByHuman, setDmSelectedAgentsByHuman] = useState<Record<string, string[]>>({});
  const [dmRemovedAgentsByHuman, setDmRemovedAgentsByHuman] = useState<Record<string, string[]>>({});

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

  // Get the title of the selected trajectory from history
  const selectedTrajectoryTitle = useMemo(() => {
    if (!selectedTrajectoryId) return null;
    return trajectoryHistory.find(t => t.id === selectedTrajectoryId)?.title ?? null;
  }, [selectedTrajectoryId, trajectoryHistory]);

  // Recent repos tracking
  const { recentRepos, addRecentRepo, getRecentProjects } = useRecentRepos();

  // Workspace repos for multi-repo workspaces
  const { repos: workspaceRepos, refetch: refetchWorkspaceRepos } = useWorkspaceRepos({
    workspaceId: effectiveActiveWorkspaceId ?? undefined,
    apiBaseUrl: '/api',
    enabled: isCloudMode && !!effectiveActiveWorkspaceId,
  });

  // Reset channel state when switching workspaces
  useEffect(() => {
    setChannelMessageMap({});
    setChannelMessages([]);
    setSelectedChannelId(undefined);
  }, [effectiveActiveWorkspaceId]);

  // Coordinator panel state
  const [isCoordinatorOpen, setIsCoordinatorOpen] = useState(false);

  // Decision queue state
  const [isDecisionQueueOpen, setIsDecisionQueueOpen] = useState(false);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [decisionProcessing, setDecisionProcessing] = useState<Record<string, boolean>>({});

  // Fleet overview state
  const [isFleetViewActive, setIsFleetViewActive] = useState(false);
  const [fleetServers, setFleetServers] = useState<ServerInfo[]>([]);

  // Auth revocation notification state
  const { toasts, addToast, dismissToast } = useToasts();
  const [authRevokedAgents, setAuthRevokedAgents] = useState<Set<string>>(new Set());
  const [selectedServerId, setSelectedServerId] = useState<string | undefined>();

  // Task creation state (tasks are stored in beads, not local state)
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  // Mobile sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Unread message notification state for mobile
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);
  const lastSeenMessageCountRef = useRef<number>(0);
  const sidebarClosedRef = useRef<boolean>(true); // Track if sidebar is currently closed
  const [dmSeenAt, setDmSeenAt] = useState<Map<string, number>>(new Map());
  const lastNotifiedMessageIdRef = useRef<string | null>(null);

  // Close sidebar when selecting an agent or project on mobile
  const closeSidebarOnMobile = useCallback(() => {
    if (window.innerWidth <= 768) {
      setIsSidebarOpen(false);
    }
  }, []);

  // Merge AI agents, human users, and local agents from linked daemons
  const combinedAgents = useMemo(() => {
    return mergeAgentsForDashboard({
      agents: data?.agents,
      users: data?.users,
      localAgents,
    });
  }, [data?.agents, data?.users, localAgents]);

  // Mark a DM conversation as seen (used for unread badges)
  const markDmSeen = useCallback((username: string) => {
    setDmSeenAt((prev) => {
      const next = new Map(prev);
      next.set(username.toLowerCase(), Date.now());
      return next;
    });
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
    agents: combinedAgents,
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

  // Human context (DM inline view)
  const currentHuman = useMemo(() => {
    if (!currentChannel) return null;
    return combinedAgents.find(
      (a) => a.isHuman && a.name.toLowerCase() === currentChannel.toLowerCase()
    ) || null;
  }, [combinedAgents, currentChannel]);

  const selectedDmAgents = useMemo(
    () => (currentHuman ? dmSelectedAgentsByHuman[currentHuman.name] ?? [] : []),
    [currentHuman, dmSelectedAgentsByHuman]
  );
  const removedDmAgents = useMemo(
    () => (currentHuman ? dmRemovedAgentsByHuman[currentHuman.name] ?? [] : []),
    [currentHuman, dmRemovedAgentsByHuman]
  );

  // Use DM hook for message filtering and deduplication
  const { visibleMessages: dedupedVisibleMessages, participantAgents: dmParticipantAgents } = useDirectMessage({
    currentHuman,
    currentUserName: currentUser?.displayName ?? null,
    messages,
    agents,
    selectedDmAgents,
    removedDmAgents,
  });

  // For local mode: convert relay messages to channel message format
  // Filter messages by channel (checking multiple fields for compatibility)
  const localChannelMessages = useMemo((): ChannelApiMessage[] => {
    if (effectiveActiveWorkspaceId || !selectedChannelId) return [];

    // Filter messages that belong to this channel
    const filtered = messages.filter(m => {
      // Activity feed shows broadcasts (to='*')
      if (selectedChannelId === ACTIVITY_FEED_ID) {
        return m.to === '*' || m.isBroadcast;
      }
      // Check if message is explicitly for this channel (CHANNEL_MESSAGE format)
      if (m.to === selectedChannelId) return true;
      // Check channel property for channel messages
      if (m.channel === selectedChannelId) return true;
      // Legacy: messages with this channel as thread
      if (m.thread === selectedChannelId) return true;
      return false;
    });

    // Convert to ChannelMessage format
    return filtered.map(m => ({
      id: m.id,
      channelId: selectedChannelId,
      from: m.from,
      fromEntityType: (m.from === 'Dashboard' || m.from === currentUser?.displayName) ? 'user' : 'agent' as const,
      content: m.content,
      timestamp: m.timestamp,
      isRead: m.isRead ?? true,
      threadId: m.thread !== selectedChannelId ? m.thread : undefined,
    }));
  }, [messages, selectedChannelId, effectiveActiveWorkspaceId, currentUser?.displayName]);

  // Use local or cloud messages depending on mode
  const effectiveChannelMessages = effectiveActiveWorkspaceId ? channelMessages : localChannelMessages;

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

  // Unread counts for human conversations (DMs)
  const humanUnreadCounts = useMemo(() => {
    if (!currentUser) return {};

    const counts: Record<string, number> = {};
    const humanNameSet = new Set(
      combinedAgents.filter((a) => a.isHuman).map((a) => a.name.toLowerCase())
    );

    for (const msg of data?.messages ?? []) {
      const sender = msg.from;
      const recipient = msg.to;
      if (!sender || !recipient) continue;

      const isToCurrentUser = recipient === currentUser.displayName;
      const senderIsHuman = humanNameSet.has(sender.toLowerCase());
      if (!isToCurrentUser || !senderIsHuman) continue;

      const seenAt = dmSeenAt.get(sender.toLowerCase()) ?? 0;
      const ts = new Date(msg.timestamp).getTime();
      if (ts > seenAt) {
        counts[sender] = (counts[sender] || 0) + 1;
      }
    }

    return counts;
  }, [combinedAgents, currentUser, data?.messages, dmSeenAt]);

  // Mark DM as seen when actively viewing a human channel
  useEffect(() => {
    if (!currentUser || !currentChannel) return;
    const humanNameSet = new Set(
      combinedAgents.filter((a) => a.isHuman).map((a) => a.name.toLowerCase())
    );
    if (humanNameSet.has(currentChannel.toLowerCase())) {
      markDmSeen(currentChannel);
    }
  }, [combinedAgents, currentChannel, currentUser, markDmSeen]);

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

  // Detect auth revocation messages and show notification
  useEffect(() => {
    if (!data?.messages) return;

    for (const msg of data.messages) {
      // Check for auth_revoked control messages
      if (msg.content?.includes('auth_revoked') || msg.content?.includes('authentication_error')) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.type === 'auth_revoked' && parsed.agent) {
            const agentName = parsed.agent;
            if (!authRevokedAgents.has(agentName)) {
              setAuthRevokedAgents(prev => new Set([...prev, agentName]));
              addToast({
                type: 'error',
                title: 'Authentication Expired',
                message: `${agentName}'s API credentials have expired. Please reconnect.`,
                agentName,
                duration: 0, // Don't auto-dismiss
                action: {
                  label: 'Reconnect',
                  onClick: () => {
                    window.location.href = '/providers';
                  },
                },
              });
            }
          }
        } catch {
          // Not JSON, check for plain text auth error patterns
          if (msg.content?.includes('OAuth token') && msg.content?.includes('expired')) {
            const agentName = msg.from;
            if (agentName && !authRevokedAgents.has(agentName)) {
              setAuthRevokedAgents(prev => new Set([...prev, agentName]));
              addToast({
                type: 'error',
                title: 'Authentication Expired',
                message: `${agentName}'s API credentials have expired. Please reconnect.`,
                agentName,
                duration: 0,
                action: {
                  label: 'Reconnect',
                  onClick: () => {
                    window.location.href = '/providers';
                  },
                },
              });
            }
          }
        }
      }
    }
  }, [data?.messages, authRevokedAgents, addToast]);

  // Check if fleet view is available
  const isFleetAvailable = Boolean(data?.fleet?.servers?.length) || workspaces.length > 0;

  // Convert workspaces/repos to projects for unified navigation
  useEffect(() => {
    if (workspaces.length > 0) {
      // If we have repos for the active workspace, show each repo as a project folder
      if (workspaceRepos.length > 1 && effectiveActiveWorkspaceId) {
        const projectList: Project[] = workspaceRepos.map((repo) => ({
          id: repo.id,
          path: repo.githubFullName,
          name: repo.githubFullName.split('/').pop() || repo.githubFullName,
          agents: orchestratorAgents
            .filter((a) => a.workspaceId === effectiveActiveWorkspaceId)
            .map((a) => ({
              name: a.name,
              status: a.status === 'running' ? 'online' : 'offline',
              isSpawned: true,
              cli: a.provider,
            })) as Agent[],
          lead: undefined,
        }));
        setProjects(projectList);
        // Set first repo as current if none selected
        if (!currentProject || !projectList.find(p => p.id === currentProject)) {
          setCurrentProject(projectList[0]?.id);
        }
      } else {
        // Single repo or no repos fetched yet - show workspace as single project
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
    }
  }, [workspaces, orchestratorAgents, activeWorkspaceId, workspaceRepos, effectiveActiveWorkspaceId, currentProject]);

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
  // But always include human users so they appear in the sidebar for DM
  const localAgentsForSidebar = useMemo(() => {
    // Human users should always be shown in sidebar for DM access
    const humanUsers = projectAgents.filter(a => a.isHuman);

    if (mergedProjects.length > 0) {
      // Don't show AI agents separately - they're merged into projects
      // But keep human users visible for DM conversations
      return humanUsers;
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
    // Switch to DM view mode and clear channel selection
    setViewMode('local');
    setSelectedChannelId(undefined);

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
    // Switch to DM view mode and clear channel selection
    setViewMode('local');
    setSelectedChannelId(undefined);
    selectAgent(agent.name);
    setCurrentChannel(agent.name);
    closeSidebarOnMobile();
  }, [selectAgent, setCurrentChannel, closeSidebarOnMobile]);

  // Handle spawn button click
  const handleSpawnClick = useCallback(() => {
    setSpawnError(null);
    setIsSpawnModalOpen(true);
  }, []);

  // Handle settings click - opens full settings page
  const handleSettingsClick = useCallback(() => {
    setSettingsInitialTab('dashboard');
    setIsFullSettingsOpen(true);
  }, []);

  // Handle workspace settings click - opens full settings page with workspace tab
  const handleWorkspaceSettingsClick = useCallback(() => {
    setSettingsInitialTab('workspace');
    setIsFullSettingsOpen(true);
  }, []);

  // Handle billing click - opens full settings page with billing tab
  const handleBillingClick = useCallback(() => {
    setSettingsInitialTab('billing');
    setIsFullSettingsOpen(true);
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

  // Open a DM with a human user from the sidebar
  const handleHumanSelect = useCallback((human: Agent) => {
    // Switch to DM view mode and clear channel selection
    setViewMode('local');
    setSelectedChannelId(undefined);
    setCurrentChannel(human.name);
    markDmSeen(human.name);
    closeSidebarOnMobile();
  }, [closeSidebarOnMobile, markDmSeen, setCurrentChannel]);

  // Handle channel member click - switch to DM with that member
  const handleChannelMemberClick = useCallback((memberId: string, entityType: 'user' | 'agent') => {
    // Don't navigate to self
    if (memberId === currentUser?.displayName) return;

    // Switch from channel view to local (DM) view
    setViewMode('local');
    setSelectedChannelId(undefined);

    // Select the agent or user
    if (entityType === 'agent') {
      selectAgent(memberId);
      setCurrentChannel(memberId);
    } else {
      // For users, just set the channel
      setCurrentChannel(memberId);
    }

    closeSidebarOnMobile();
  }, [currentUser?.displayName, selectAgent, setCurrentChannel, closeSidebarOnMobile]);

  // =============================================================================
  // Channel V1 Handlers
  // =============================================================================

  // Default channels that should always be visible - stable reference
  const defaultChannels = useMemo<Channel[]>(() => [
    {
      id: '#general',
      name: 'general',
      description: 'General discussion for all agents',
      visibility: 'public',
      memberCount: 0,
      unreadCount: 0,
      hasMentions: false,
      createdAt: '2024-01-01T00:00:00.000Z', // Static date for stability
      status: 'active',
      createdBy: 'system',
      isDm: false,
    },
    {
      id: '#engineering',
      name: 'engineering',
      description: 'Engineering discussion',
      visibility: 'public',
      memberCount: 0,
      unreadCount: 0,
      hasMentions: false,
      createdAt: '2024-01-01T00:00:00.000Z', // Static date for stability
      status: 'active',
      createdBy: 'system',
      isDm: false,
    },
  ], []);

  // Load channels on mount (they're always visible in sidebar, collapsed by default)
  useEffect(() => {
    // Not in cloud mode or no workspace - show default channels only
    if (!isCloudMode || !effectiveActiveWorkspaceId) {
      setChannelsList(defaultChannels);
      setArchivedChannelsList([]);
      return;
    }

    // Cloud mode with workspace - fetch from API and merge with defaults
    setChannelsList(defaultChannels);
    setArchivedChannelsList([]);
    setIsChannelsLoading(true);

    const fetchChannels = async () => {
      try {
        const response = await listChannels(effectiveActiveWorkspaceId);
        setChannelListsFromResponse(response);
      } catch (err) {
        console.error('Failed to fetch channels:', err);
      } finally {
        setIsChannelsLoading(false);
      }
    };

    fetchChannels();
  }, [effectiveActiveWorkspaceId, isCloudMode, defaultChannels, setChannelListsFromResponse]);

  // Load messages when a channel is selected (persisted + live)
  useEffect(() => {
    if (!selectedChannelId || viewMode !== 'channels') return;

    // Check if we already have messages cached
    const existing = channelMessageMap[selectedChannelId] ?? [];
    if (existing.length > 0) {
      setChannelMessages(existing);
      setHasMoreMessages(false);
    } else if (!fetchedChannelsRef.current.has(selectedChannelId)) {
      // Only fetch if we haven't already fetched this channel (prevents infinite loop)
      fetchedChannelsRef.current.add(selectedChannelId);
      (async () => {
        try {
          const response = await getMessages(effectiveActiveWorkspaceId || 'local', selectedChannelId, { limit: 200 });
          setChannelMessageMap(prev => ({ ...prev, [selectedChannelId]: response.messages }));
          setChannelMessages(response.messages);
          setHasMoreMessages(response.hasMore);
        } catch (err) {
          console.error('Failed to fetch channel messages:', err);
          setChannelMessages([]);
          setHasMoreMessages(false);
        }
      })();
    } else {
      // Already fetched but no messages - show empty state
      setChannelMessages([]);
      setHasMoreMessages(false);
    }

    setChannelUnreadState(undefined);
    setChannelsList(prev =>
      prev.map(c =>
        c.id === selectedChannelId ? { ...c, unreadCount: 0, hasMentions: false } : c
      )
    );
  }, [selectedChannelId, viewMode, effectiveActiveWorkspaceId]); // Removed channelMessageMap to prevent infinite loop

  // Channel selection handler - also joins the channel in local mode
  const handleSelectChannel = useCallback(async (channel: Channel) => {
    setSelectedChannelId(channel.id);
    closeSidebarOnMobile();

    // Join the channel via the daemon (needed for local mode)
    // This ensures the user is a member before sending messages
    try {
      const { joinChannel: joinChannelApi } = await import('./channels');
      await joinChannelApi(effectiveActiveWorkspaceId || 'local', channel.id);
    } catch (err) {
      console.error('Failed to join channel:', err);
    }
  }, [closeSidebarOnMobile, effectiveActiveWorkspaceId]);

  // Create channel handler - opens the create channel modal
  const handleCreateChannel = useCallback(() => {
    setIsCreateChannelOpen(true);
  }, []);

  // Handler for creating a new channel via API
  const handleCreateChannelSubmit = useCallback(async (request: CreateChannelRequest) => {
    if (!effectiveActiveWorkspaceId) return;
    setIsCreatingChannel(true);
    try {
      const result = await createChannel(effectiveActiveWorkspaceId, request);
      // Refresh channels list after successful creation
      const response = await listChannels(effectiveActiveWorkspaceId);
      setChannelListsFromResponse(response);
      if (result.channel?.id) {
        setSelectedChannelId(result.channel.id);
      }
      setIsCreateChannelOpen(false);
    } catch (err) {
      console.error('Failed to create channel:', err);
      // Keep modal open on error so user can retry
    } finally {
      setIsCreatingChannel(false);
    }
  }, [effectiveActiveWorkspaceId]);

  // Handler for opening the invite to channel modal
  const handleInviteToChannel = useCallback((channel: Channel) => {
    setInviteChannelTarget(channel);
    setIsInviteChannelOpen(true);
  }, []);

  // Handler for inviting members to a channel
  // Note: InviteToChannelModal is given agents as availableMembers, so all invitees are agents
  const handleInviteSubmit = useCallback(async (members: string[]) => {
    if (!inviteChannelTarget) return;
    setIsInvitingToChannel(true);
    try {
      // Call the invite API endpoint with CSRF token
      const csrfToken = getCsrfToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      // Send invites with type info - all members from invite modal are agents
      const invites = members.map(name => ({ id: name, type: 'agent' as const }));

      const response = await fetch('/api/channels/invite', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          channel: inviteChannelTarget.name,
          invites,
          workspaceId: effectiveActiveWorkspaceId,
        }),
      });
      if (!response.ok) {
        throw new Error('Failed to invite members');
      }
      setIsInviteChannelOpen(false);
      setInviteChannelTarget(null);
    } catch (err) {
      console.error('Failed to invite to channel:', err);
    } finally {
      setIsInvitingToChannel(false);
    }
  }, [inviteChannelTarget, effectiveActiveWorkspaceId]);

  // Join channel handler
  const handleJoinChannel = useCallback(async (channelId: string) => {
    if (!effectiveActiveWorkspaceId) return;
    try {
      const { joinChannel } = await import('./channels');
      await joinChannel(effectiveActiveWorkspaceId, channelId);
      // Refresh channels list
      const response = await listChannels(effectiveActiveWorkspaceId);
      setChannelListsFromResponse(response);
    } catch (err) {
      console.error('Failed to join channel:', err);
    }
  }, [effectiveActiveWorkspaceId, setChannelListsFromResponse]);

  // Leave channel handler
  const handleLeaveChannel = useCallback(async (channel: Channel) => {
    if (!effectiveActiveWorkspaceId) return;
    try {
      const { leaveChannel } = await import('./channels');
      await leaveChannel(effectiveActiveWorkspaceId, channel.id);
      // Clear selection if leaving current channel
      if (selectedChannelId === channel.id) {
        setSelectedChannelId(undefined);
      }
      // Refresh channels list
      const response = await listChannels(effectiveActiveWorkspaceId);
      setChannelListsFromResponse(response);
    } catch (err) {
      console.error('Failed to leave channel:', err);
    }
  }, [effectiveActiveWorkspaceId, selectedChannelId, setChannelListsFromResponse]);

  // Show members panel handler
  const handleShowMembers = useCallback(async () => {
    if (!selectedChannel || !effectiveActiveWorkspaceId) return;
    try {
      const members = await getChannelMembers(effectiveActiveWorkspaceId, selectedChannel.id);
      setChannelMembers(members);
      setShowMemberPanel(true);
    } catch (err) {
      console.error('Failed to load channel members:', err);
    }
  }, [selectedChannel, effectiveActiveWorkspaceId]);

  // Remove member handler
  const handleRemoveMember = useCallback(async (memberId: string, memberType: 'user' | 'agent') => {
    if (!selectedChannel || !effectiveActiveWorkspaceId) return;
    try {
      await removeChannelMember(effectiveActiveWorkspaceId, selectedChannel.id, memberId, memberType);
      // Refresh members list
      const members = await getChannelMembers(effectiveActiveWorkspaceId, selectedChannel.id);
      setChannelMembers(members);
    } catch (err) {
      console.error('Failed to remove member:', err);
    }
  }, [selectedChannel, effectiveActiveWorkspaceId]);

  // Add member handler (for MemberManagementPanel)
  const handleAddMember = useCallback(async (memberId: string, memberType: 'user' | 'agent', _role: 'admin' | 'member' | 'read_only') => {
    if (!selectedChannel || !effectiveActiveWorkspaceId) return;
    try {
      const csrfToken = getCsrfToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch('/api/channels/invite', {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          channel: selectedChannel.name,
          invites: [{ id: memberId, type: memberType }],
          workspaceId: effectiveActiveWorkspaceId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to add member');
      }

      // Refresh members list
      const members = await getChannelMembers(effectiveActiveWorkspaceId, selectedChannel.id);
      setChannelMembers(members);
    } catch (err) {
      console.error('Failed to add member:', err);
    }
  }, [selectedChannel, effectiveActiveWorkspaceId]);

  // Archive channel handler
  const handleArchiveChannel = useCallback(async (channel: Channel) => {
    if (!effectiveActiveWorkspaceId) return;
    try {
      const { archiveChannel } = await import('./channels');
      await archiveChannel(effectiveActiveWorkspaceId, channel.id);
      // Clear selection if archiving current channel
      if (selectedChannelId === channel.id) {
        setSelectedChannelId(undefined);
      }
      // Refresh channels list
      const response = await listChannels(effectiveActiveWorkspaceId);
      setChannelListsFromResponse(response);
    } catch (err) {
      console.error('Failed to archive channel:', err);
    }
  }, [effectiveActiveWorkspaceId, selectedChannelId, setChannelListsFromResponse]);

  // Unarchive channel handler
  const handleUnarchiveChannel = useCallback(async (channel: Channel) => {
    if (!effectiveActiveWorkspaceId) return;
    try {
      const { unarchiveChannel } = await import('./channels');
      await unarchiveChannel(effectiveActiveWorkspaceId, channel.id);
      // Refresh channels list
      const response = await listChannels(effectiveActiveWorkspaceId);
      setChannelListsFromResponse(response);
    } catch (err) {
      console.error('Failed to unarchive channel:', err);
    }
  }, [effectiveActiveWorkspaceId, setChannelListsFromResponse]);

  // Send message to channel handler
  const handleSendChannelMessage = useCallback(async (content: string, threadId?: string) => {
    if (!selectedChannelId) return;

    const senderName = currentUser?.displayName || 'Dashboard';
    const optimisticMessage: ChannelApiMessage = {
      id: `local-${Date.now()}`,
      channelId: selectedChannelId,
      from: senderName,
      fromEntityType: 'user',
      content,
      timestamp: new Date().toISOString(),
      threadId,
      isRead: true,
    };

    // Optimistic append; daemon will echo back via WS
    appendChannelMessage(selectedChannelId, optimisticMessage, { incrementUnread: false });

    try {
      await sendChannelApiMessage(
        effectiveActiveWorkspaceId || 'local',
        selectedChannelId,
        { content, threadId }
      );
    } catch (err) {
      console.error('Failed to send channel message:', err);
    }
  }, [effectiveActiveWorkspaceId, selectedChannelId, currentUser?.displayName, appendChannelMessage]);

  // Load more messages (pagination) handler
  const handleLoadMoreMessages = useCallback(async () => {
    // Pagination not yet supported for daemon channels
    return;
  }, []);

  // Mark channel as read handler (with debouncing via useRef)
  const markReadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const handleMarkChannelRead = useCallback((channelId: string) => {
    if (!effectiveActiveWorkspaceId) return;

    // Clear existing timeout to debounce
    if (markReadTimeoutRef.current) {
      clearTimeout(markReadTimeoutRef.current);
    }

    // Debounce the markRead call (500ms delay)
    markReadTimeoutRef.current = setTimeout(async () => {
      try {
        await markRead(effectiveActiveWorkspaceId, channelId);
        // Update local unread state
        setChannelUnreadState(undefined);
        // Update channel list unread counts
        setChannelsList(prev => prev.map(c =>
          c.id === channelId ? { ...c, unreadCount: 0, hasMentions: false } : c
        ));
      } catch (err) {
        console.error('Failed to mark channel as read:', err);
      }
    }, 500);
  }, [effectiveActiveWorkspaceId]);

  // Auto-mark channel as read when viewing it
  useEffect(() => {
    if (!selectedChannelId || !channelUnreadState || channelUnreadState.count === 0) return;
    if (viewMode !== 'channels') return;

    // Mark as read when channel is viewed and has unread messages
    handleMarkChannelRead(selectedChannelId);
  }, [selectedChannelId, channelUnreadState, viewMode, handleMarkChannelRead]);

  // Cleanup markRead timeout on unmount
  useEffect(() => {
    return () => {
      if (markReadTimeoutRef.current) {
        clearTimeout(markReadTimeoutRef.current);
      }
    };
  }, []);

  const handleDmAgentToggle = useCallback((agentName: string) => {
    if (!currentHuman) return;
    const humanName = currentHuman.name;
    const isSelected = (dmSelectedAgentsByHuman[humanName] ?? []).includes(agentName);

    setDmSelectedAgentsByHuman((prev) => {
      const currentList = prev[humanName] ?? [];
      const nextList = isSelected
        ? currentList.filter((a) => a !== agentName)
        : [...currentList, agentName];
      return { ...prev, [humanName]: nextList };
    });

    setDmRemovedAgentsByHuman((prev) => {
      const currentList = prev[humanName] ?? [];
      if (isSelected) {
        // Mark as removed so derived participants don't auto-readd
        return currentList.includes(agentName)
          ? prev
          : { ...prev, [humanName]: [...currentList, agentName] };
      }
      // Re-adding clears removal
      return { ...prev, [humanName]: currentList.filter((a) => a !== agentName) };
    });
  }, [currentHuman, dmSelectedAgentsByHuman]);

  const handleDmSend = useCallback(async (content: string, attachmentIds?: string[]): Promise<boolean> => {
    if (!currentHuman) return false;
    const humanName = currentHuman.name;

    // Always send to the human
    await sendMessage(humanName, content, undefined, attachmentIds);

    // Only send to agents if they were explicitly selected for this conversation
    // Don't send to agents in pure 1:1 human conversations
    if (selectedDmAgents.length > 0) {
      for (const agent of selectedDmAgents) {
        await sendMessage(agent, content, undefined, attachmentIds);
      }
    }

    return true;
  }, [currentHuman, selectedDmAgents, sendMessage]);

  const handleMainComposerSend = useCallback(
    async (content: string, attachmentIds?: string[]) => {
      const recipient = currentChannel === 'general' ? '*' : currentChannel;

      if (currentHuman) {
        return handleDmSend(content, attachmentIds);
      }

      return sendMessage(recipient, content, undefined, attachmentIds);
    },
    [currentChannel, currentHuman, handleDmSend, sendMessage]
  );

  const dmInviteCommands = useMemo(() => {
    if (!currentHuman) return [];
    return agents
      .filter((a) => !a.isHuman)
      .map((agent) => {
        const isSelected = (dmSelectedAgentsByHuman[currentHuman.name] ?? []).includes(agent.name);
        return {
          id: `dm-toggle-${currentHuman.name}-${agent.name}`,
          label: `${isSelected ? 'Remove' : 'Invite'} ${agent.name} in DM`,
          description: `DM with ${currentHuman.name}`,
          category: 'actions' as const,
          action: () => handleDmAgentToggle(agent.name),
        };
      });
  }, [agents, currentHuman, dmSelectedAgentsByHuman, handleDmAgentToggle]);

  // Channel commands for command palette
  const channelCommands = useMemo(() => {
    const commands: Array<{
      id: string;
      label: string;
      description?: string;
      category: 'channels';
      shortcut?: string;
      action: () => void;
    }> = [];

    // Switch to channels view
    commands.push({
      id: 'channels-view',
      label: 'Go to Channels',
      description: 'Switch to channel messaging view',
      category: 'channels',
      shortcut: '⌘⇧C',
      action: () => {
        setViewMode('channels');
      },
    });

    // Create new channel
    commands.push({
      id: 'channels-create',
      label: 'Create Channel',
      description: 'Create a new messaging channel',
      category: 'channels',
      action: () => {
        setViewMode('channels');
        handleCreateChannel();
      },
    });

    // Add each channel as a quick-switch command
    channelsList.forEach((channel) => {
      const unreadBadge = channel.unreadCount > 0 ? ` (${channel.unreadCount} unread)` : '';
      commands.push({
        id: `channel-switch-${channel.id}`,
        label: channel.isDm ? `@${channel.name}` : `#${channel.name}`,
        description: channel.description || `Switch to ${channel.isDm ? 'DM' : 'channel'}${unreadBadge}`,
        category: 'channels',
        action: () => {
          setViewMode('channels');
          setSelectedChannelId(channel.id);
        },
      });
    });

    return commands;
  }, [channelsList, handleCreateChannel]);

  // Handle send from new conversation modal - select the channel after sending
  const handleNewConversationSend = useCallback(async (to: string, content: string): Promise<boolean> => {
    const success = await sendMessage(to, content);
    if (success) {
      // Switch to the channel we just messaged
      if (to === '*') {
        selectAgent(null);
        setSelectedChannelId(ACTIVITY_FEED_ID);
        setViewMode('channels');
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

  // Handle server reconnect (restart workspace)
  const handleServerReconnect = useCallback(async (serverId: string) => {
    if (isCloudMode) {
      try {
        const result = await cloudApi.restartWorkspace(serverId);
        if (result.success) {
          // Update the fleet servers state to show the server is restarting
          setFleetServers(prev => prev.map(s =>
            s.id === serverId ? { ...s, status: 'connecting' as const } : s
          ));
          // Refresh cloud workspaces after a short delay to get updated status
          setTimeout(async () => {
            try {
              const workspacesResult = await cloudApi.getWorkspaceSummary();
              if (workspacesResult.success && workspacesResult.data.workspaces) {
                setCloudWorkspaces(workspacesResult.data.workspaces);
              }
            } catch (err) {
              console.error('Failed to refresh workspaces after reconnect:', err);
            }
          }, 2000);
        } else {
          console.error('Failed to restart workspace:', result.error);
        }
      } catch (err) {
        console.error('Failed to reconnect to server:', err);
      }
    } else {
      // For orchestrator mode, attempt to reconnect by removing and re-adding the workspace
      console.warn('Server reconnect not fully supported in orchestrator mode');
      // Refresh the workspace list as a fallback
      // The orchestrator's WebSocket will handle reconnection automatically
    }
  }, [isCloudMode]);

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

  // Persist settings changes
  useEffect(() => {
    saveSettingsToStorage(settings);
  }, [settings]);

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

  // Request browser notification permissions when enabled
  useEffect(() => {
    if (!settings.notifications.desktop) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    if (Notification.permission === 'granted') return;

    if (Notification.permission === 'denied') {
      updateSettings((prev) => ({
        ...prev,
        notifications: {
          ...prev.notifications,
          desktop: false,
          enabled: prev.notifications.sound || prev.notifications.mentionsOnly,
        },
      }));
      return;
    }

    Notification.requestPermission().then((permission) => {
      if (permission !== 'granted') {
        updateSettings((prev) => ({
          ...prev,
          notifications: {
            ...prev.notifications,
            desktop: false,
            enabled: prev.notifications.sound || prev.notifications.mentionsOnly,
          },
        }));
      }
    }).catch(() => undefined);
  }, [settings.notifications.desktop, settings.notifications.sound, settings.notifications.mentionsOnly, updateSettings]);

  // Browser notifications and sounds for new messages
  useEffect(() => {
    const messages = data?.messages;
    if (!messages || messages.length === 0) {
      lastNotifiedMessageIdRef.current = null;
      return;
    }

    const latestMessage = messages[messages.length - 1];

    if (!settings.notifications.enabled) {
      lastNotifiedMessageIdRef.current = latestMessage?.id ?? null;
      return;
    }

    if (!lastNotifiedMessageIdRef.current) {
      lastNotifiedMessageIdRef.current = latestMessage.id;
      return;
    }

    const lastNotifiedIndex = messages.findIndex((message) => (
      message.id === lastNotifiedMessageIdRef.current
    ));

    if (lastNotifiedIndex === -1) {
      lastNotifiedMessageIdRef.current = latestMessage.id;
      return;
    }

    const newMessages = messages.slice(lastNotifiedIndex + 1);
    if (newMessages.length === 0) {
      return;
    }

    lastNotifiedMessageIdRef.current = latestMessage.id;

    const isFromCurrentUser = (message: Message) =>
      message.from === 'Dashboard' ||
      (currentUser && message.from === currentUser.displayName);

    const isMessageInCurrentChannel = (message: Message) => {
      if (currentChannel === 'general') {
        return message.to === '*' || message.isBroadcast || message.channel === 'general';
      }
      return message.from === currentChannel || message.to === currentChannel;
    };

    const shouldNotifyForMessage = (message: Message) => {
      if (isFromCurrentUser(message)) return false;
      if (settings.notifications.mentionsOnly && currentUser?.displayName) {
        if (!message.content.includes(`@${currentUser.displayName}`)) {
          return false;
        }
      }
      const isActive = typeof document !== 'undefined' ? !document.hidden : false;
      if (isActive && isMessageInCurrentChannel(message)) return false;
      return true;
    };

    let shouldPlaySound = false;

    for (const message of newMessages) {
      if (!shouldNotifyForMessage(message)) continue;

      if (settings.notifications.desktop && typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'granted') {
          const channelLabel = message.to === '*' ? 'Activity' : message.to;
          const body = message.content.split('\n')[0].slice(0, 160);
          const notification = new Notification(`${message.from} → ${channelLabel}`, { body });
          notification.onclick = () => {
            window.focus();
            if (message.to === '*') {
              setSelectedChannelId(ACTIVITY_FEED_ID);
              setViewMode('channels');
            } else {
              setCurrentChannel(message.from);
            }
            notification.close();
          };
        }
      }

      if (settings.notifications.sound) {
        shouldPlaySound = true;
      }
    }

    if (shouldPlaySound) {
      playNotificationSound();
    }
  }, [data?.messages, settings.notifications, currentChannel, currentUser, setCurrentChannel]);

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

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        e.preventDefault();
        setViewMode('channels');
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
        setIsFullSettingsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSpawnClick, handleNewConversationClick]);

  // Handle billing result routes (success/cancel after Stripe checkout)
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();

  if (pathname === '/billing/success') {
    return (
      <BillingResult
        type="success"
        sessionId={searchParams.get('session_id') || undefined}
        onClose={() => {
          window.location.href = '/';
        }}
      />
    );
  }

  if (pathname === '/billing/canceled') {
    return (
      <BillingResult
        type="canceled"
        onClose={() => {
          window.location.href = '/';
        }}
      />
    );
  }

  return (
    <WorkspaceProvider wsUrl={wsUrl}>
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
            workspaces={effectiveWorkspaces}
            activeWorkspaceId={effectiveActiveWorkspaceId ?? undefined}
            onSelect={handleEffectiveWorkspaceSelect}
            onAddWorkspace={() => setIsAddWorkspaceOpen(true)}
            onWorkspaceSettings={handleWorkspaceSettingsClick}
            isLoading={effectiveIsLoading}
          />
        </div>

        {/* Unified Sidebar - Channels collapsed by default, Agents always visible */}
        <Sidebar
          agents={localAgentsForSidebar}
          bridgeAgents={bridgeAgents}
          projects={mergedProjects}
          currentUserName={currentUser?.displayName}
          humanUnreadCounts={humanUnreadCounts}
          currentProject={currentProject}
          selectedAgent={selectedAgent?.name}
          viewMode={viewMode}
          isFleetAvailable={isFleetAvailable}
          isConnected={isConnected || isOrchestratorConnected}
          isOpen={isSidebarOpen}
          activeThreads={activeThreads}
          currentThread={currentThread}
          totalUnreadThreadCount={totalUnreadThreadCount}
          channels={channelsList
            .filter(c => !c.isDm && !c.id.startsWith('dm:'))
            .map(c => ({
              id: c.id,
              name: c.name,
              unreadCount: c.unreadCount,
              hasMentions: c.hasMentions,
            }))}
          archivedChannels={archivedChannelsList
            .filter(c => !c.isDm && !c.id.startsWith('dm:'))
            .map((c) => ({
              id: c.id,
              name: c.name,
              unreadCount: c.unreadCount ?? 0,
              hasMentions: c.hasMentions,
            }))}
          selectedChannelId={selectedChannelId}
          isActivitySelected={selectedChannelId === ACTIVITY_FEED_ID}
          activityUnreadCount={0}
          onActivitySelect={() => {
            setSelectedChannelId(ACTIVITY_FEED_ID);
            selectAgent(null);
            setViewMode('channels');
          }}
          onChannelSelect={(channel) => {
            const fullChannel =
              channelsList.find(c => c.id === channel.id) ||
              archivedChannelsList.find(c => c.id === channel.id);
            if (fullChannel) {
              handleSelectChannel(fullChannel);
              setViewMode('channels');
            }
          }}
          onCreateChannel={handleCreateChannel}
          onInviteToChannel={(channel) => {
            const fullChannel = channelsList.find(c => c.id === channel.id);
            if (fullChannel) {
              handleInviteToChannel(fullChannel);
            }
          }}
          onArchiveChannel={(channel) => {
            const fullChannel = channelsList.find((c) => c.id === channel.id);
            if (fullChannel) {
              handleArchiveChannel(fullChannel);
            }
          }}
          onUnarchiveChannel={(channel) => {
            const fullChannel =
              archivedChannelsList.find((c) => c.id === channel.id) ||
              channelsList.find((c) => c.id === channel.id);
            if (fullChannel) {
              handleUnarchiveChannel(fullChannel);
            }
          }}
          onAgentSelect={handleAgentSelect}
          onHumanSelect={handleHumanSelect}
          onProjectSelect={handleProjectSelect}
          onViewModeChange={setViewMode}
          onSpawnClick={handleSpawnClick}
          onReleaseClick={handleReleaseAgent}
          onLogsClick={handleLogsClick}
          onProfileClick={setSelectedAgentProfile}
          onThreadSelect={setCurrentThread}
          onClose={() => setIsSidebarOpen(false)}
          onSettingsClick={handleSettingsClick}
          onTrajectoryClick={() => setIsTrajectoryOpen(true)}
          hasActiveTrajectory={trajectoryStatus?.active}
          onFleetClick={() => setIsFleetViewActive(!isFleetViewActive)}
          isFleetViewActive={isFleetViewActive}
          onCoordinatorClick={handleCoordinatorClick}
          hasMultipleProjects={mergedProjects.length > 1}
        />
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-bg-secondary/50 overflow-hidden">
        {/* Header - fixed on mobile for keyboard-safe positioning, sticky on desktop */}
        <div className="fixed top-0 left-0 right-0 z-50 md:sticky md:top-0 md:left-auto md:right-auto bg-bg-secondary">
          <Header
          currentChannel={currentChannel}
          selectedAgent={selectedAgent}
          projects={mergedProjects}
          currentProject={mergedProjects.find(p => p.id === currentProject) || null}
          recentProjects={getRecentProjects(mergedProjects)}
          viewMode={viewMode}
          selectedChannelName={selectedChannel?.name}
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
        {/* Usage banner for free tier users */}
        <UsageBanner onUpgradeClick={handleBillingClick} />
        </div>
        {/* Spacer for fixed header on mobile - matches header height (52px) */}
        <div className="h-[52px] flex-shrink-0 md:hidden" />
        {/* Online users indicator - outside fixed header so it scrolls with content on mobile */}
        {currentUser && onlineUsers.length > 0 && (
          <div className="flex items-center justify-end px-4 py-1 bg-bg-tertiary/80 border-b border-border-subtle flex-shrink-0">
            <OnlineUsersIndicator
              onlineUsers={onlineUsers}
              onUserClick={setSelectedUserProfile}
            />
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Message List */}
          <div className={`flex-1 min-h-0 overflow-y-auto ${currentThread ? 'hidden md:block md:flex-[2]' : ''}`}>
            {currentHuman && (
              <div className="px-4 py-2 border-b border-border-subtle bg-bg-secondary flex flex-col gap-2 sticky top-0 z-10">
                <div className="text-xs text-text-muted">
                  DM with <span className="font-semibold text-text-primary">{currentHuman.name}</span>. Invite agents:
                </div>
                <div className="flex flex-wrap gap-2">
                  {agents
                    .filter((a) => !a.isHuman)
                    .map((agent) => {
                      const isSelected = (dmSelectedAgentsByHuman[currentHuman.name] ?? []).includes(agent.name);
                      return (
                        <button
                          key={agent.name}
                          onClick={() => handleDmAgentToggle(agent.name)}
                          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                            isSelected
                              ? 'bg-accent-cyan text-bg-deep'
                              : 'bg-bg-tertiary text-text-secondary hover:bg-bg-tertiary/80'
                          }`}
                          title={agent.name}
                        >
                          {isSelected ? '✓ ' : ''}{agent.name}
                        </button>
                      );
                    })}
                  {agents.filter((a) => !a.isHuman).length === 0 && (
                    <span className="text-xs text-text-muted">No agents available</span>
                  )}
                </div>
              </div>
            )}
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
                  onServerReconnect={handleServerReconnect}
                  isLoading={!data}
                />
              </div>
            ) : selectedChannelId === ACTIVITY_FEED_ID ? (
              <ActivityFeed
                events={activityEvents}
                maxEvents={100}
              />
            ) : viewMode === 'channels' && selectedChannel ? (
              <ChannelViewV1
                channel={selectedChannel}
                messages={effectiveChannelMessages}
                currentUser={currentUser?.displayName || 'Anonymous'}
                isLoadingMore={false}
                hasMoreMessages={hasMoreMessages && !!effectiveActiveWorkspaceId}
                mentionSuggestions={agents.map(a => a.name)}
                unreadState={channelUnreadState}
                onSendMessage={handleSendChannelMessage}
                onLoadMore={handleLoadMoreMessages}
                onThreadClick={(messageId) => setCurrentThread(messageId)}
                onShowMembers={handleShowMembers}
                onMemberClick={handleChannelMemberClick}
              />
            ) : viewMode === 'channels' ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted text-center px-4">
                <HashIconLarge />
                <h2 className="m-0 mb-2 font-display text-text-primary">Select a channel</h2>
                <p className="text-text-secondary">Choose a channel from the sidebar to start messaging</p>
              </div>
            ) : (
              <MessageList
                messages={dedupedVisibleMessages}
                currentChannel={currentChannel}
                currentThread={currentThread}
                onThreadClick={(messageId) => setCurrentThread(messageId)}
                highlightedMessageId={currentThread ?? undefined}
                agents={combinedAgents}
                currentUser={currentUser}
                skipChannelFilter={currentHuman !== null}
                showTimestamps={settings.display.showTimestamps}
                autoScrollDefault={settings.messages.autoScroll}
                compactMode={settings.display.compactMode}
                onAgentClick={setSelectedAgentProfile}
                onUserClick={setSelectedUserProfile}
                onlineUsers={onlineUsers}
              />
            )}
          </div>

          {/* Thread Panel */}
          {currentThread && (() => {
            // Determine which message list to search based on view mode
            const isChannelView = viewMode === 'channels';

            // Helper to convert ChannelMessage to Message format for ThreadPanel
            const convertChannelMessage = (cm: ChannelApiMessage): Message => ({
              id: cm.id,
              from: cm.from,
              to: cm.channelId,
              content: cm.content,
              timestamp: cm.timestamp,
              thread: cm.threadId,
              isRead: cm.isRead,
              replyCount: cm.threadSummary?.replyCount,
              threadSummary: cm.threadSummary,
            });

            let originalMessage: Message | null = null;
            let isTopicThread = false;

            if (isChannelView) {
              const channelMsg = effectiveChannelMessages.find((m) => m.id === currentThread);
              if (channelMsg) {
                originalMessage = convertChannelMessage(channelMsg);
              } else {
                isTopicThread = true;
                const threadMsgs = effectiveChannelMessages
                  .filter((m) => m.threadId === currentThread)
                  .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                if (threadMsgs[0]) {
                  originalMessage = convertChannelMessage(threadMsgs[0]);
                }
              }
            } else {
              originalMessage = messages.find((m) => m.id === currentThread) ?? null;
              isTopicThread = !originalMessage;
              if (!originalMessage) {
                const threadMsgs = messages
                  .filter((m) => m.thread === currentThread)
                  .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                originalMessage = threadMsgs[0] ?? null;
              }
            }

            // Get thread replies based on view mode
            const replies: Message[] = isChannelView
              ? effectiveChannelMessages
                  .filter((m) => m.threadId === currentThread)
                  .map(convertChannelMessage)
              : threadMessages(currentThread);

            return (
              <div className="w-full md:w-[400px] md:min-w-[320px] md:max-w-[500px] flex-shrink-0">
                  <ThreadPanel
                    originalMessage={originalMessage}
                    replies={replies}
                    onClose={() => setCurrentThread(null)}
                    showTimestamps={settings.display.showTimestamps}
                    onReply={async (content) => {
                    if (isChannelView && selectedChannel) {
                      // For channels, send threaded message
                      await handleSendChannelMessage(content, currentThread);
                      return true;
                    }
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

        {/* Message Composer - hide in channels mode (ChannelViewV1 has its own input) */}
        {viewMode !== 'channels' && (
          <div className="p-2 sm:p-4 bg-bg-tertiary border-t border-border-subtle">
            <MessageComposer
              agents={agents}
              humanUsers={humanUsers}
              onSend={handleMainComposerSend}
              onTyping={sendTyping}
              isSending={isSending}
              error={sendError}
              insertMention={pendingMention}
              onMentionInserted={() => setPendingMention(undefined)}
              enableFileAutocomplete
              placeholder={`Message ${currentChannel === 'general' ? 'everyone' : '@' + currentChannel}...`}
            />
          </div>
        )}
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
        customCommands={[...dmInviteCommands, ...channelCommands]}
      />

      {/* Spawn Modal */}
      <SpawnModal
        isOpen={isSpawnModalOpen}
        onClose={() => setIsSpawnModalOpen(false)}
        onSpawn={handleSpawn}
        existingAgents={agents.map((a) => a.name)}
        isSpawning={isSpawning}
        error={spawnError}
        isCloudMode={isCloudMode}
        workspaceId={effectiveActiveWorkspaceId ?? undefined}
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

      {/* Create Channel Modal */}
      <CreateChannelModal
        isOpen={isCreateChannelOpen}
        onClose={() => setIsCreateChannelOpen(false)}
        onCreate={handleCreateChannelSubmit}
        isLoading={isCreatingChannel}
        existingChannels={channelsList.map(c => c.name)}
        availableMembers={agents.map(a => a.name)}
      />

      {/* Invite to Channel Modal */}
      <InviteToChannelModal
        isOpen={isInviteChannelOpen}
        channelName={inviteChannelTarget?.name || ''}
        onClose={() => {
          setIsInviteChannelOpen(false);
          setInviteChannelTarget(null);
        }}
        onInvite={handleInviteSubmit}
        isLoading={isInvitingToChannel}
        availableMembers={agents.map(a => a.name)}
      />

      {/* Member Management Panel */}
      {selectedChannel && (
        <MemberManagementPanel
          channel={selectedChannel}
          members={channelMembers}
          isOpen={showMemberPanel}
          onClose={() => setShowMemberPanel(false)}
          onAddMember={handleAddMember}
          onRemoveMember={handleRemoveMember}
          onUpdateRole={() => {}}
          currentUserId={currentUser?.displayName}
          availableAgents={agents.map(a => ({ name: a.name }))}
          workspaceId={effectiveActiveWorkspaceId ?? undefined}
        />
      )}

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
                agentName={selectedTrajectoryTitle?.slice(0, 30) || trajectoryStatus?.task?.slice(0, 30) || 'Trajectories'}
                steps={trajectorySteps}
                history={trajectoryHistory}
                selectedTrajectoryId={selectedTrajectoryId}
                onSelectTrajectory={selectTrajectory}
                isLoading={isTrajectoryLoading}
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
          // Set pending mention to trigger insertion in MessageComposer
          setPendingMention(username);
          setSelectedUserProfile(null);
        }}
        onSendMessage={(user) => {
          setCurrentChannel(user.username);
          markDmSeen(user.username);
          setSelectedUserProfile(null);
        }}
      />

      {/* Agent Profile Panel */}
      <AgentProfilePanel
        agent={selectedAgentProfile}
        onClose={() => setSelectedAgentProfile(null)}
        onMessage={(agent) => {
          selectAgent(agent.name);
          setCurrentChannel(agent.name);
          setSelectedAgentProfile(null);
        }}
        onLogs={handleLogsClick}
        onRelease={handleReleaseAgent}
        summary={selectedAgentProfile ? agentSummariesMap.get(selectedAgentProfile.name.toLowerCase()) : null}
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

      {/* Full Settings Page */}
      {isFullSettingsOpen && (
        <SettingsPage
          currentUserId={cloudSession?.user?.id}
          initialTab={settingsInitialTab}
          onClose={() => setIsFullSettingsOpen(false)}
          settings={settings}
          onUpdateSettings={updateSettings}
          activeWorkspaceId={effectiveActiveWorkspaceId}
        />
      )}

      {/* Toast Notifications */}
      <NotificationToast
        toasts={toasts}
        onDismiss={dismissToast}
        position="top-right"
      />
    </div>
    </WorkspaceProvider>
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

function HashIconLarge() {
  return (
    <svg className="text-text-muted mb-4" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

/**
 * Legacy CSS styles export - kept for backwards compatibility
 * @deprecated Use Tailwind classes directly instead
 */
export const appStyles = '';
