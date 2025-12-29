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
import { CommandPalette } from './CommandPalette';
import { SpawnModal, type SpawnConfig } from './SpawnModal';
import { SettingsPanel, defaultSettings, type Settings } from './SettingsPanel';
import { MentionAutocomplete, getMentionQuery, completeMentionInValue } from './MentionAutocomplete';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgents } from './hooks/useAgents';
import { useMessages } from './hooks/useMessages';
import { api } from '../lib/api';

export interface AppProps {
  /** Initial WebSocket URL (optional, defaults to current host) */
  wsUrl?: string;
}

export function App({ wsUrl }: AppProps) {
  // WebSocket connection for real-time data
  const { data, isConnected, error: wsError } = useWebSocket({ url: wsUrl });

  // View mode state
  const [viewMode, setViewMode] = useState<'local' | 'fleet'>('local');

  // Project state for unified navigation
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<string | undefined>();

  // Spawn modal state
  const [isSpawnModalOpen, setIsSpawnModalOpen] = useState(false);
  const [isSpawning, setIsSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  // Command palette state
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

  // Settings panel state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(defaultSettings);

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
  const isFleetAvailable = Boolean(data?.fleet?.servers?.length);

  // Fetch bridge/project data when fleet is available
  useEffect(() => {
    if (!isFleetAvailable) return;

    const fetchProjects = async () => {
      const result = await api.getBridgeData();
      if (result.success && result.data) {
        // Destructure to avoid non-null assertion in closure
        const { servers, agents } = result.data;
        // Convert fleet servers to projects
        const projectList: Project[] = servers.map((server) => ({
          id: server.id,
          path: server.url,
          name: server.name || server.url.split('/').pop(),
          agents: agents.filter((a) => a.server === server.id),
          lead: undefined, // Could be enhanced to detect lead agent
        }));
        setProjects(projectList);
      }
    };

    fetchProjects();
    // Refresh periodically
    const interval = setInterval(fetchProjects, 30000);
    return () => clearInterval(interval);
  }, [isFleetAvailable]);

  // Handle project selection
  const handleProjectSelect = useCallback((project: Project) => {
    setCurrentProject(project.id);
    // Optionally navigate to project's first agent or general channel
    if (project.agents.length > 0) {
      selectAgent(project.agents[0].name);
      setCurrentChannel(project.agents[0].name);
    }
    closeSidebarOnMobile();
  }, [selectAgent, setCurrentChannel, closeSidebarOnMobile]);

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

  // Handle spawn agent
  const handleSpawn = useCallback(async (config: SpawnConfig): Promise<boolean> => {
    setIsSpawning(true);
    setSpawnError(null);
    try {
      const result = await api.spawnAgent({ name: config.name, cli: config.command, team: config.team });
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
  }, []);

  // Handle release/kill agent
  const handleReleaseAgent = useCallback(async (agent: Agent) => {
    if (!agent.isSpawned) return;

    const confirmed = window.confirm(`Are you sure you want to release agent "${agent.name}"?`);
    if (!confirmed) return;

    try {
      const result = await api.releaseAgent(agent.name);
      if (!result.success) {
        console.error('Failed to release agent:', result.error);
      }
    } catch (err) {
      console.error('Failed to release agent:', err);
    }
  }, []);

  // Handle command palette
  const handleCommandPaletteOpen = useCallback(() => {
    setIsCommandPaletteOpen(true);
  }, []);

  // Apply theme to document
  React.useEffect(() => {
    const applyTheme = (theme: 'light' | 'dark' | 'system') => {
      let effectiveTheme: 'light' | 'dark';

      if (theme === 'system') {
        // Check system preference
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        effectiveTheme = prefersDark ? 'dark' : 'light';
      } else {
        effectiveTheme = theme;
      }

      // Apply theme to document root
      document.documentElement.setAttribute('data-theme', effectiveTheme);
    };

    applyTheme(settings.theme);

    // Listen for system theme changes when in 'system' mode
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
      // Cmd/Ctrl + K for command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(true);
      }

      // Cmd/Ctrl + Shift + S for spawn agent
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 's') {
        e.preventDefault();
        handleSpawnClick();
      }

      // Escape to close modals
      if (e.key === 'Escape') {
        setIsCommandPaletteOpen(false);
        setIsSpawnModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSpawnClick]);

  return (
    <div className="dashboard-app">
      {/* Mobile Sidebar Overlay */}
      <div
        className={`sidebar-overlay ${isSidebarOpen ? 'visible' : ''}`}
        onClick={() => setIsSidebarOpen(false)}
      />

      {/* Sidebar */}
      <Sidebar
        agents={agents}
        projects={projects}
        currentProject={currentProject}
        selectedAgent={selectedAgent?.name}
        viewMode={viewMode}
        isFleetAvailable={isFleetAvailable}
        isConnected={isConnected}
        isOpen={isSidebarOpen}
        onAgentSelect={handleAgentSelect}
        onProjectSelect={handleProjectSelect}
        onViewModeChange={setViewMode}
        onSpawnClick={handleSpawnClick}
        onReleaseClick={handleReleaseAgent}
        onClose={() => setIsSidebarOpen(false)}
      />

      {/* Main Content */}
      <main className="dashboard-main">
        {/* Header */}
        <Header
          currentChannel={currentChannel}
          selectedAgent={selectedAgent}
          onCommandPaletteOpen={handleCommandPaletteOpen}
          onSettingsClick={handleSettingsClick}
          onMenuClick={() => setIsSidebarOpen(true)}
        />

        {/* Content Area */}
        <div className="dashboard-content">
          {wsError ? (
            <div className="error-state">
              <ErrorIcon />
              <h2>Connection Error</h2>
              <p>{wsError.message}</p>
              <button onClick={() => window.location.reload()}>
                Retry Connection
              </button>
            </div>
          ) : !data ? (
            <div className="loading-state">
              <LoadingSpinner />
              <p>Connecting to dashboard...</p>
            </div>
          ) : (
            <div className="messages-container">
              <MessageList
                messages={messages}
                currentChannel={currentChannel}
                onThreadClick={(messageId) => setCurrentThread(messageId)}
                highlightedMessageId={currentThread ?? undefined}
              />
            </div>
          )}
        </div>

        {/* Message Composer */}
        <div className="message-composer">
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
        onClose={() => setIsCommandPaletteOpen(false)}
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

  // Check for @mention on input change
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || 0;
    setMessage(value);
    setCursorPosition(cursorPos);

    // Show autocomplete if typing @mention at start
    const query = getMentionQuery(value, cursorPos);
    setShowMentions(query !== null);
  };

  // Handle keyboard events - Enter to send, Shift+Enter for new line
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (message.trim() && !isSending) {
        handleSubmit(e as unknown as React.FormEvent);
      }
    }
  };

  // Handle mention selection
  const handleMentionSelect = (mention: string, newValue: string) => {
    setMessage(newValue);
    setShowMentions(false);
    // Focus textarea and set cursor after the mention
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

    // Parse message to determine target
    // If message starts with @AgentName, extract the target and message content
    const mentionMatch = message.match(/^@(\S+)\s*([\s\S]*)/);
    let target: string;
    let content: string;

    if (mentionMatch) {
      // User explicitly mentioned someone - route to that agent
      const mentionedName = mentionMatch[1];
      content = mentionMatch[2] || '';

      // Check if it's a broadcast mention (@everyone, @*, @all)
      if (mentionedName === '*' || mentionedName.toLowerCase() === 'everyone' || mentionedName.toLowerCase() === 'all') {
        target = '*';
      } else {
        target = mentionedName;
      }
    } else {
      // No @mention - use context-aware routing
      // If in general channel, broadcast to everyone
      // If in a DM, stay in that DM
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
    <form className="composer-form" onSubmit={handleSubmit}>
      <div className="composer-input-wrapper">
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
          className="composer-input"
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
        className="composer-send"
        disabled={!message.trim() || isSending}
        title={isSending ? 'Sending...' : 'Send message'}
      >
        {isSending ? (
          <span className="composer-send-text">Sending...</span>
        ) : (
          <>
            <span className="composer-send-text">Send</span>
            <svg className="composer-send-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </>
        )}
      </button>
      {error && <span className="composer-error">{error}</span>}
    </form>
  );
}

function LoadingSpinner() {
  return (
    <svg className="spinner" width="24" height="24" viewBox="0 0 24 24">
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
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/**
 * CSS styles for the main app - Dark mode styling matching v1 dashboard
 */
export const appStyles = `
.dashboard-app {
  display: flex;
  height: 100vh;
  background: #1a1d21;
}

.dashboard-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #222529;
}

.dashboard-content {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.messages-container {
  height: 100%;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #8d8d8e;
  text-align: center;
}

.loading-state .spinner {
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
  color: #00ffc8;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.error-state svg {
  color: #e01e5a;
  margin-bottom: 16px;
}

.error-state h2 {
  margin: 0 0 8px;
  color: #d1d2d3;
}

.error-state p {
  color: #8d8d8e;
}

.error-state button {
  margin-top: 16px;
  padding: 8px 16px;
  background: #1264a3;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.2s;
}

.error-state button:hover {
  background: #0d4f82;
}

.messages-placeholder {
  background: #1a1d21;
  border-radius: 8px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.agent-summary {
  margin-top: 16px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 4px;
}

.agent-summary p {
  margin: 4px 0;
  font-size: 13px;
  color: #ababad;
}

.message-composer {
  padding: 16px 20px;
  background: #222529;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.composer-form {
  display: flex;
  gap: 8px;
  align-items: center;
}

.composer-input-wrapper {
  flex: 1;
  position: relative;
}

.composer-input {
  width: 100%;
  padding: 10px 14px;
  background: #222529;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  color: #d1d2d3;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
  resize: none;
  min-height: 40px;
  max-height: 120px;
  overflow-y: auto;
}

.composer-input::placeholder {
  color: #8d8d8e;
}

.composer-input:focus {
  border-color: #1264a3;
}

/* Mention Autocomplete Styles - Dark mode */
.mention-autocomplete {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 200px;
  overflow-y: auto;
  background: #1a1d21;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.4);
  z-index: 100;
  margin-bottom: 4px;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.mention-item:hover,
.mention-item.selected {
  background: rgba(255, 255, 255, 0.08);
}

.mention-avatar {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 11px;
  font-weight: 600;
}

.mention-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mention-name {
  font-size: 14px;
  font-weight: 500;
  color: #d1d2d3;
}

.mention-description {
  font-size: 12px;
  color: #8d8d8e;
}

.composer-send {
  padding: 10px 20px;
  background: #1264a3;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.composer-send:hover:not(:disabled) {
  background: #0d4f82;
}

.composer-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.composer-error {
  color: #e01e5a;
  font-size: 12px;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: #1a1d21;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 24px;
  min-width: 400px;
  max-width: 90vw;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
}

.modal h2 {
  margin: 0 0 16px;
  color: #d1d2d3;
}

.command-palette {
  background: #1a1d21;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 8px;
  width: 500px;
  max-width: 90vw;
}

.command-palette input {
  width: 100%;
  padding: 12px 16px;
  background: transparent;
  border: none;
  font-size: 16px;
  color: #d1d2d3;
  outline: none;
}

.command-palette input::placeholder {
  color: #8d8d8e;
}
`;
