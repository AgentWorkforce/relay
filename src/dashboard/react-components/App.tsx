/**
 * Dashboard V2 - Main Application Component
 *
 * Root component that combines sidebar, header, and main content area.
 * Manages global state via hooks and provides context to child components.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { Agent, Project } from '../types';
import { Sidebar } from './layout/Sidebar';
import { Header } from './layout/Header';
import { MessageList } from './MessageList';
import { ThreadPanel } from './ThreadPanel';
import { CommandPalette } from './CommandPalette';
import { SpawnModal, type SpawnConfig } from './SpawnModal';
import { NewConversationModal } from './NewConversationModal';
import { SettingsPanel, defaultSettings, type Settings } from './SettingsPanel';
import { ConversationHistory } from './ConversationHistory';
import { MentionAutocomplete, getMentionQuery, completeMentionInValue } from './MentionAutocomplete';
import { WorkspaceSelector, type Workspace } from './WorkspaceSelector';
import { AddWorkspaceModal } from './AddWorkspaceModal';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgents } from './hooks/useAgents';
import { useMessages } from './hooks/useMessages';
import { useOrchestrator } from './hooks/useOrchestrator';
import { api } from '../lib/api';

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

  // Mobile sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

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
    sendMessage,
    isSending,
    sendError,
  } = useMessages({
    messages: data?.messages ?? [],
  });

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

  // Fallback: Fetch bridge/project data when fleet is available (legacy)
  useEffect(() => {
    if (workspaces.length > 0) return; // Skip if using orchestrator
    if (!data?.fleet?.servers?.length) return;

    const fetchProjects = async () => {
      const result = await api.getBridgeData();
      if (result.success && result.data) {
        const { servers, agents } = result.data;
        const projectList: Project[] = servers.map((server) => ({
          id: server.id,
          path: server.url,
          name: server.name || server.url.split('/').pop(),
          agents: agents.filter((a) => a.server === server.id),
          lead: undefined,
        }));
        setProjects(projectList);
      }
    };

    fetchProjects();
    const interval = setInterval(fetchProjects, 30000);
    return () => clearInterval(interval);
  }, [data?.fleet?.servers?.length, workspaces.length]);

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
  }, [selectAgent, setCurrentChannel, closeSidebarOnMobile, workspaces.length, switchWorkspace]);

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
        shadowOf: config.shadowOf,
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSpawnClick, handleNewConversationClick]);

  return (
    <div className="flex h-screen bg-bg-primary">
      {/* Mobile Sidebar Overlay */}
      <div
        className={`
          fixed inset-0 bg-black/50 z-[999] transition-opacity duration-200
          md:hidden
          ${isSidebarOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}
        `}
        onClick={() => setIsSidebarOpen(false)}
      />

      {/* Sidebar with Workspace Selector */}
      <div className="flex flex-col w-[280px] h-screen bg-sidebar-bg">
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
          agents={agents}
          projects={projects}
          currentProject={currentProject}
          selectedAgent={selectedAgent?.name}
          viewMode={viewMode}
          isFleetAvailable={isFleetAvailable}
          isConnected={isConnected || isOrchestratorConnected}
          isOpen={isSidebarOpen}
          onAgentSelect={handleAgentSelect}
          onProjectSelect={handleProjectSelect}
          onViewModeChange={setViewMode}
          onSpawnClick={handleSpawnClick}
          onReleaseClick={handleReleaseAgent}
          onClose={() => setIsSidebarOpen(false)}
        />
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-bg-secondary">
        {/* Header */}
        <Header
          currentChannel={currentChannel}
          selectedAgent={selectedAgent}
          onCommandPaletteOpen={handleCommandPaletteOpen}
          onSettingsClick={handleSettingsClick}
          onHistoryClick={handleHistoryClick}
          onNewConversationClick={handleNewConversationClick}
          onMenuClick={() => setIsSidebarOpen(true)}
        />

        {/* Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Message List */}
          <div className={`flex-1 overflow-y-auto ${currentThread ? 'hidden md:block md:flex-[2]' : ''}`}>
            {wsError ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted text-center">
                <ErrorIcon />
                <h2 className="m-0 mb-2 text-text-primary">Connection Error</h2>
                <p className="text-text-muted">{wsError.message}</p>
                <button
                  className="mt-4 py-2 px-4 bg-accent text-white border-none rounded cursor-pointer transition-colors duration-200 hover:bg-accent-hover"
                  onClick={() => window.location.reload()}
                >
                  Retry Connection
                </button>
              </div>
            ) : !data ? (
              <div className="flex flex-col items-center justify-center h-full text-text-muted text-center">
                <LoadingSpinner />
                <p>Connecting to dashboard...</p>
              </div>
            ) : (
              <div className="h-full">
                <MessageList
                  messages={messages}
                  currentChannel={currentChannel}
                  onThreadClick={(messageId) => setCurrentThread(messageId)}
                  highlightedMessageId={currentThread ?? undefined}
                />
              </div>
            )}
          </div>

          {/* Thread Panel */}
          {currentThread && (
            <div className="w-full md:w-[400px] md:min-w-[320px] md:max-w-[500px] flex-shrink-0">
              <ThreadPanel
                originalMessage={messages.find((m) => m.id === currentThread) ?? null}
                replies={threadMessages(currentThread)}
                onClose={() => setCurrentThread(null)}
                onReply={async (content) => {
                  // Send reply with thread ID
                  const originalMessage = messages.find((m) => m.id === currentThread);
                  if (!originalMessage) return false;
                  return sendMessage(originalMessage.from, content, currentThread);
                }}
                isSending={isSending}
              />
            </div>
          )}
        </div>

        {/* Message Composer */}
        <div className="p-4 bg-bg-secondary border-t border-border-light">
          <MessageComposer
            recipient={currentChannel === 'general' ? '*' : currentChannel}
            agents={agents}
            onSend={sendMessage}
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
    </div>
  );
}

/**
 * Message Composer Component with @-mention autocomplete
 */
interface MessageComposerProps {
  recipient: string;
  agents: Agent[];
  onSend: (to: string, content: string) => Promise<boolean>;
  isSending: boolean;
  error: string | null;
}

function MessageComposer({ recipient, agents, onSend, isSending, error }: MessageComposerProps) {
  const [message, setMessage] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [showMentions, setShowMentions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setMessage(value);
    setCursorPosition(cursorPos);

    const query = getMentionQuery(value, cursorPos);
    setShowMentions(query !== null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (message.trim() && !isSending) {
        handleSubmit(e as unknown as React.FormEvent);
      }
    }
  };

  const handleMentionSelect = (mention: string, newValue: string) => {
    setMessage(newValue);
    setShowMentions(false);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const pos = newValue.indexOf(' ') + 1;
        textareaRef.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isSending) return;

    const mentionMatch = message.match(/^@(\S+)\s*([\s\S]*)/);
    let target: string;
    let content: string;

    if (mentionMatch) {
      const mentionedName = mentionMatch[1];
      content = mentionMatch[2] || '';

      if (mentionedName === '*' || mentionedName.toLowerCase() === 'everyone' || mentionedName.toLowerCase() === 'all') {
        target = '*';
      } else {
        target = mentionedName;
      }
    } else {
      target = recipient;
      content = message;
    }

    const success = await onSend(target, content || message);
    if (success) {
      setMessage('');
      setShowMentions(false);
    }
  };

  return (
    <form className="flex items-center gap-2" onSubmit={handleSubmit}>
      <div className="flex-1 relative">
        <MentionAutocomplete
          agents={agents}
          inputValue={message}
          cursorPosition={cursorPosition}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentions(false)}
          isVisible={showMentions}
        />
        <textarea
          ref={textareaRef}
          className="w-full py-2.5 px-3.5 bg-bg-secondary border border-border rounded-md text-sm font-sans text-text-primary outline-none transition-colors duration-200 resize-none min-h-[40px] max-h-[120px] overflow-y-auto focus:border-accent placeholder:text-text-muted"
          placeholder={`Message ${recipient === '*' ? 'everyone' : '@' + recipient}... (Shift+Enter for new line)`}
          value={message}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onSelect={(e) => setCursorPosition((e.target as HTMLTextAreaElement).selectionStart || 0)}
          disabled={isSending}
          rows={1}
        />
      </div>
      <button
        type="submit"
        className="py-2.5 px-5 bg-accent text-white border-none rounded-md text-sm cursor-pointer transition-colors duration-200 hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={!message.trim() || isSending}
        title={isSending ? 'Sending...' : 'Send message'}
      >
        {isSending ? (
          <span>Sending...</span>
        ) : (
          <span className="flex items-center gap-1.5">
            Send
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </span>
        )}
      </button>
      {error && <span className="text-error text-xs ml-2">{error}</span>}
    </form>
  );
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin mb-4 text-success" width="24" height="24" viewBox="0 0 24 24">
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
