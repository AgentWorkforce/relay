/**
 * SettingsPanel Component
 *
 * Dashboard settings and preferences panel with
 * appearance, notifications, and connection options.
 */

import React, { useState, useCallback } from 'react';

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  notifications: {
    enabled: boolean;
    sound: boolean;
    desktop: boolean;
    mentionsOnly: boolean;
  };
  display: {
    compactMode: boolean;
    showTimestamps: boolean;
    showAvatars: boolean;
    animationsEnabled: boolean;
  };
  connection: {
    autoReconnect: boolean;
    reconnectDelay: number;
    keepAliveInterval: number;
  };
}

export const defaultSettings: Settings = {
  theme: 'system',
  notifications: {
    enabled: true,
    sound: true,
    desktop: false,
    mentionsOnly: false,
  },
  display: {
    compactMode: false,
    showTimestamps: true,
    showAvatars: true,
    animationsEnabled: true,
  },
  connection: {
    autoReconnect: true,
    reconnectDelay: 3000,
    keepAliveInterval: 30000,
  },
};

interface AIProvider {
  id: string;
  name: string;
  displayName: string;
  description: string;
  color: string;
  cliCommand: string;
  apiKeyUrl?: string; // URL to get API key (fallback)
  apiKeyName?: string; // How the API key is labeled on their site
  supportsOAuth?: boolean; // Whether CLI-based OAuth is supported
  isConnected?: boolean;
}

const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    displayName: 'Claude',
    description: 'Claude Code - recommended for code tasks',
    color: '#D97757',
    cliCommand: 'claude',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    apiKeyName: 'API key',
    supportsOAuth: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    displayName: 'Codex',
    description: 'Codex - OpenAI coding assistant',
    color: '#10A37F',
    cliCommand: 'codex login',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    apiKeyName: 'API key',
    supportsOAuth: true,
  },
  {
    id: 'google',
    name: 'Google',
    displayName: 'Gemini',
    description: 'Gemini - Google AI coding assistant',
    color: '#4285F4',
    cliCommand: 'gemini',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    apiKeyName: 'API key',
    supportsOAuth: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    displayName: 'OpenCode',
    description: 'OpenCode - AI coding assistant',
    color: '#00D4AA',
    cliCommand: 'opencode',
    supportsOAuth: true,
  },
  {
    id: 'droid',
    name: 'Factory',
    displayName: 'Droid',
    description: 'Droid - Factory AI coding agent',
    color: '#6366F1',
    cliCommand: 'droid',
    supportsOAuth: true,
  },
];

// Auth session state for CLI-based OAuth
interface OAuthSession {
  providerId: string;
  sessionId: string;
  authUrl?: string;
  status: 'starting' | 'waiting_auth' | 'success' | 'error';
  error?: string;
}

export interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  onResetSettings?: () => void;
  workspaceId?: string; // For cloud mode provider connection
  csrfToken?: string; // For cloud mode API calls
}

// Trajectory settings state
interface TrajectorySettings {
  storeInRepo: boolean;
  storageLocation: string;
  loading: boolean;
  error: string | null;
  documentation?: {
    title: string;
    description: string;
    whatIsIt: string;
    benefits: string[];
    storeInRepoExplanation: string;
    learnMore: string;
  };
}

export function SettingsPanel({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  onResetSettings,
  workspaceId,
  csrfToken,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'appearance' | 'notifications' | 'connection' | 'providers' | 'trajectories'>('appearance');
  const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>({});
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const [oauthSession, setOauthSession] = useState<OAuthSession | null>(null);
  const [showApiKeyFallback, setShowApiKeyFallback] = useState<Record<string, boolean>>({});
  const [trajectorySettings, setTrajectorySettings] = useState<TrajectorySettings>({
    storeInRepo: false,
    storageLocation: '',
    loading: true,
    error: null,
  });

  // Load trajectory settings on mount
  React.useEffect(() => {
    if (isOpen && activeTab === 'trajectories') {
      fetchTrajectorySettings();
    }
  }, [isOpen, activeTab]);

  const fetchTrajectorySettings = async () => {
    try {
      setTrajectorySettings(prev => ({ ...prev, loading: true, error: null }));
      const res = await fetch('/api/settings/trajectory');
      if (!res.ok) throw new Error('Failed to load settings');
      const data = await res.json();
      setTrajectorySettings({
        storeInRepo: data.settings.storeInRepo,
        storageLocation: data.settings.storageLocation,
        loading: false,
        error: null,
        documentation: data.documentation,
      });
    } catch (err) {
      setTrajectorySettings(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load settings',
      }));
    }
  };

  const updateTrajectorySettings = async (storeInRepo: boolean) => {
    try {
      setTrajectorySettings(prev => ({ ...prev, loading: true, error: null }));
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch('/api/settings/trajectory', {
        method: 'PUT',
        credentials: 'include',
        headers,
        body: JSON.stringify({ storeInRepo }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update settings');
      }

      const data = await res.json();
      setTrajectorySettings(prev => ({
        ...prev,
        storeInRepo: data.settings.storeInRepo,
        storageLocation: data.settings.storageLocation,
        loading: false,
        error: null,
      }));
    } catch (err) {
      setTrajectorySettings(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to update settings',
      }));
    }
  };

  // Start CLI-based OAuth flow for a provider
  const startOAuthFlow = async (provider: AIProvider) => {
    setProviderError(null);
    setConnectingProvider(provider.id);
    setOauthSession({ providerId: provider.id, sessionId: '', status: 'starting' });

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/onboarding/cli/${provider.id}/start`, {
        method: 'POST',
        credentials: 'include',
        headers,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to start authentication');
      }

      // Handle immediate success (already authenticated)
      if (data.status === 'success' || data.alreadyAuthenticated) {
        setProviderStatus(prev => ({ ...prev, [provider.id]: true }));
        setOauthSession(null);
        setConnectingProvider(null);
        return;
      }

      const session: OAuthSession = {
        providerId: provider.id,
        sessionId: data.sessionId,
        authUrl: data.authUrl,
        status: data.status || 'starting',
      };
      setOauthSession(session);

      // If we have an auth URL, open it in a popup
      if (data.authUrl) {
        openAuthPopup(data.authUrl, provider.displayName);
        // Start polling for completion
        pollAuthStatus(provider.id, data.sessionId);
      } else if (data.status === 'starting') {
        // Still starting, poll for URL
        pollAuthStatus(provider.id, data.sessionId);
      }
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : 'Failed to start OAuth');
      setOauthSession(null);
      setConnectingProvider(null);
    }
  };

  // Open auth URL in a popup window
  const openAuthPopup = (url: string, providerName: string) => {
    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    window.open(
      url,
      `${providerName} Login`,
      `width=${width},height=${height},left=${left},top=${top},popup=yes`
    );
  };

  // Poll for OAuth session status
  const pollAuthStatus = async (providerId: string, sessionId: string) => {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        setProviderError('Authentication timed out. Please try again.');
        setOauthSession(null);
        setConnectingProvider(null);
        return;
      }

      try {
        const res = await fetch(`/api/onboarding/cli/${providerId}/status/${sessionId}`, {
          credentials: 'include',
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Failed to check status');
        }

        if (data.status === 'success') {
          // Complete the auth flow
          await completeAuthFlow(providerId, sessionId);
          return;
        } else if (data.status === 'error') {
          throw new Error(data.error || 'Authentication failed');
        } else if (data.status === 'waiting_auth' && data.authUrl && !oauthSession?.authUrl) {
          // Got the auth URL, open popup
          setOauthSession(prev => prev ? { ...prev, authUrl: data.authUrl, status: 'waiting_auth' } : null);
          openAuthPopup(data.authUrl, AI_PROVIDERS.find(p => p.id === providerId)?.displayName || 'Provider');
        }

        // Continue polling
        attempts++;
        setTimeout(poll, 5000);
      } catch (err) {
        setProviderError(err instanceof Error ? err.message : 'Auth check failed');
        setOauthSession(null);
        setConnectingProvider(null);
      }
    };

    poll();
  };

  // Complete OAuth flow
  const completeAuthFlow = async (providerId: string, sessionId: string) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/onboarding/cli/${providerId}/complete/${sessionId}`, {
        method: 'POST',
        credentials: 'include',
        headers,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to complete authentication');
      }

      // Success!
      setProviderStatus(prev => ({ ...prev, [providerId]: true }));
      setOauthSession(null);
      setConnectingProvider(null);
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : 'Failed to complete auth');
      setOauthSession(null);
      setConnectingProvider(null);
    }
  };

  // Cancel OAuth flow
  const cancelOAuthFlow = async () => {
    if (oauthSession?.sessionId) {
      try {
        await fetch(`/api/onboarding/cli/${oauthSession.providerId}/cancel/${oauthSession.sessionId}`, {
          method: 'POST',
          credentials: 'include',
        });
      } catch {
        // Ignore cancel errors
      }
    }
    setOauthSession(null);
    setConnectingProvider(null);
  };

  // Submit API key (fallback flow)
  const submitApiKey = async (provider: AIProvider) => {
    if (!apiKeyInput.trim()) {
      setProviderError('Please enter an API key');
      return;
    }

    setProviderError(null);
    setConnectingProvider(provider.id);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/onboarding/token/${provider.id}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ token: apiKeyInput.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to connect');
      }

      setProviderStatus(prev => ({ ...prev, [provider.id]: true }));
      setApiKeyInput('');
      setConnectingProvider(null);
      setShowApiKeyFallback(prev => ({ ...prev, [provider.id]: false }));
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : 'Failed to connect');
      setConnectingProvider(null);
    }
  };

  const updateSetting = useCallback(
    (
      category: 'notifications' | 'display' | 'connection',
      key: string,
      value: boolean | number
    ) => {
      const categorySettings = settings[category];
      onSettingsChange({
        ...settings,
        [category]: {
          ...categorySettings,
          [key]: value,
        },
      });
    },
    [settings, onSettingsChange]
  );

  const updateTheme = useCallback(
    (theme: Settings['theme']) => {
      onSettingsChange({ ...settings, theme });
    },
    [settings, onSettingsChange]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary rounded-xl w-[500px] max-w-[90vw] max-h-[80vh] flex flex-col shadow-modal animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between py-5 px-6 border-b border-border">
          <h2 className="m-0 text-lg font-semibold text-text-primary">Settings</h2>
          <button
            className="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-md text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-hover hover:text-text-primary"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex gap-1 py-3 px-6 border-b border-border bg-bg-tertiary">
          <button
            className={`flex items-center gap-1.5 py-2 px-3.5 bg-transparent border-none rounded-md text-[13px] cursor-pointer font-[inherit] transition-all duration-150 ${
              activeTab === 'appearance'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => setActiveTab('appearance')}
          >
            <PaletteIcon />
            Appearance
          </button>
          <button
            className={`flex items-center gap-1.5 py-2 px-3.5 bg-transparent border-none rounded-md text-[13px] cursor-pointer font-[inherit] transition-all duration-150 ${
              activeTab === 'notifications'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => setActiveTab('notifications')}
          >
            <BellIcon />
            Notifications
          </button>
          <button
            className={`flex items-center gap-1.5 py-2 px-3.5 bg-transparent border-none rounded-md text-[13px] cursor-pointer font-[inherit] transition-all duration-150 ${
              activeTab === 'connection'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => setActiveTab('connection')}
          >
            <WifiIcon />
            Connection
          </button>
          <button
            className={`flex items-center gap-1.5 py-2 px-3.5 bg-transparent border-none rounded-md text-[13px] cursor-pointer font-[inherit] transition-all duration-150 ${
              activeTab === 'providers'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => setActiveTab('providers')}
          >
            <ProviderIcon />
            Providers
          </button>
          <button
            className={`flex items-center gap-1.5 py-2 px-3.5 bg-transparent border-none rounded-md text-[13px] cursor-pointer font-[inherit] transition-all duration-150 ${
              activeTab === 'trajectories'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => setActiveTab('trajectories')}
          >
            <TrajectoryIcon />
            Trajectories
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'appearance' && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-[0.5px]">Theme</label>
                <div className="flex gap-2">
                  {(['light', 'dark', 'system'] as const).map((theme) => (
                    <button
                      key={theme}
                      className={`flex flex-col items-center gap-1.5 py-4 px-5 border-2 rounded-lg text-xs cursor-pointer font-[inherit] transition-all duration-150 flex-1 ${
                        settings.theme === theme
                          ? 'bg-accent-light border-accent text-accent'
                          : 'bg-bg-hover border-transparent text-text-secondary hover:bg-bg-active'
                      }`}
                      onClick={() => updateTheme(theme)}
                    >
                      {theme === 'light' && <SunIcon />}
                      {theme === 'dark' && <MoonIcon />}
                      {theme === 'system' && <MonitorIcon />}
                      <span>{theme.charAt(0).toUpperCase() + theme.slice(1)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-[0.5px]">Display Options</label>
                <ToggleOption
                  label="Compact mode"
                  description="Show more content in less space"
                  checked={settings.display.compactMode}
                  onChange={(v) => updateSetting('display', 'compactMode', v)}
                />
                <ToggleOption
                  label="Show timestamps"
                  description="Display time for each message"
                  checked={settings.display.showTimestamps}
                  onChange={(v) => updateSetting('display', 'showTimestamps', v)}
                />
                <ToggleOption
                  label="Show avatars"
                  description="Display agent avatars in messages"
                  checked={settings.display.showAvatars}
                  onChange={(v) => updateSetting('display', 'showAvatars', v)}
                />
                <ToggleOption
                  label="Enable animations"
                  description="Smooth transitions and effects"
                  checked={settings.display.animationsEnabled}
                  onChange={(v) => updateSetting('display', 'animationsEnabled', v)}
                />
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-[0.5px]">Notification Preferences</label>
                <ToggleOption
                  label="Enable notifications"
                  description="Receive alerts for new messages"
                  checked={settings.notifications.enabled}
                  onChange={(v) => updateSetting('notifications', 'enabled', v)}
                />
                <ToggleOption
                  label="Sound alerts"
                  description="Play sound for new messages"
                  checked={settings.notifications.sound}
                  onChange={(v) => updateSetting('notifications', 'sound', v)}
                  disabled={!settings.notifications.enabled}
                />
                <ToggleOption
                  label="Desktop notifications"
                  description="Show system notifications"
                  checked={settings.notifications.desktop}
                  onChange={(v) => updateSetting('notifications', 'desktop', v)}
                  disabled={!settings.notifications.enabled}
                />
                <ToggleOption
                  label="Mentions only"
                  description="Only notify when mentioned"
                  checked={settings.notifications.mentionsOnly}
                  onChange={(v) => updateSetting('notifications', 'mentionsOnly', v)}
                  disabled={!settings.notifications.enabled}
                />
              </div>
            </div>
          )}

          {activeTab === 'connection' && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-[0.5px]">Connection Settings</label>
                <ToggleOption
                  label="Auto-reconnect"
                  description="Automatically reconnect on disconnect"
                  checked={settings.connection.autoReconnect}
                  onChange={(v) => updateSetting('connection', 'autoReconnect', v)}
                />

                <div className="flex flex-col gap-1.5 p-3 bg-bg-hover rounded-lg">
                  <label className="text-sm font-medium text-text-primary">Reconnect delay (ms)</label>
                  <input
                    type="number"
                    className="py-2 px-3 border border-border rounded-md text-sm font-[inherit] outline-none transition-colors duration-150 bg-bg-tertiary text-text-primary focus:border-accent disabled:bg-bg-hover disabled:text-text-muted"
                    value={settings.connection.reconnectDelay}
                    onChange={(e) =>
                      updateSetting('connection', 'reconnectDelay', parseInt(e.target.value) || 3000)
                    }
                    min={1000}
                    max={30000}
                    step={1000}
                    disabled={!settings.connection.autoReconnect}
                  />
                </div>

                <div className="flex flex-col gap-1.5 p-3 bg-bg-hover rounded-lg">
                  <label className="text-sm font-medium text-text-primary">Keep-alive interval (ms)</label>
                  <input
                    type="number"
                    className="py-2 px-3 border border-border rounded-md text-sm font-[inherit] outline-none transition-colors duration-150 bg-bg-tertiary text-text-primary focus:border-accent disabled:bg-bg-hover disabled:text-text-muted"
                    value={settings.connection.keepAliveInterval}
                    onChange={(e) =>
                      updateSetting('connection', 'keepAliveInterval', parseInt(e.target.value) || 30000)
                    }
                    min={5000}
                    max={120000}
                    step={5000}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'providers' && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-3">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-[0.5px]">AI Providers</label>
                <p className="text-sm text-text-secondary">
                  Connect AI providers to spawn agents. API keys are stored securely.
                </p>

                {providerError && (
                  <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-md text-red-400 text-sm">
                    {providerError}
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  {AI_PROVIDERS.map((provider) => (
                    <div key={provider.id} className="p-4 bg-bg-hover rounded-lg border border-border">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                            style={{ backgroundColor: provider.color }}
                          >
                            {provider.displayName[0]}
                          </div>
                          <div>
                            <h4 className="text-sm font-semibold text-text-primary">{provider.displayName}</h4>
                            <p className="text-xs text-text-muted">{provider.description}</p>
                          </div>
                        </div>
                        {providerStatus[provider.id] && (
                          <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full">
                            Connected
                          </span>
                        )}
                      </div>

                      {!providerStatus[provider.id] && (
                        <div className="mt-3">
                          {/* OAuth flow (primary) */}
                          {oauthSession?.providerId === provider.id ? (
                            <div className="space-y-3">
                              {oauthSession.status === 'starting' && (
                                <div className="flex items-center gap-2 text-sm text-text-secondary">
                                  <span className="animate-spin">⏳</span>
                                  Starting authentication...
                                </div>
                              )}
                              {oauthSession.status === 'waiting_auth' && (
                                <>
                                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                                    <span className="animate-pulse">🔐</span>
                                    Complete login in the popup window
                                  </div>
                                  {oauthSession.authUrl && (
                                    <div className="text-xs text-text-muted">
                                      Popup didn&apos;t open?{' '}
                                      <button
                                        onClick={() => openAuthPopup(oauthSession.authUrl!, provider.displayName)}
                                        className="text-accent hover:underline"
                                      >
                                        Click here
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                              <button
                                onClick={cancelOAuthFlow}
                                className="text-sm text-text-muted hover:text-text-secondary"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : showApiKeyFallback[provider.id] ? (
                            /* API key fallback */
                            <div className="space-y-2">
                              <div className="flex gap-2">
                                <input
                                  type="password"
                                  placeholder={`Enter ${provider.displayName} ${provider.apiKeyName || 'API key'}`}
                                  value={connectingProvider === provider.id ? apiKeyInput : ''}
                                  onChange={(e) => {
                                    setConnectingProvider(provider.id);
                                    setApiKeyInput(e.target.value);
                                  }}
                                  onFocus={() => setConnectingProvider(provider.id)}
                                  className="flex-1 py-2 px-3 border border-border rounded-md text-sm bg-bg-tertiary text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                                />
                                <button
                                  onClick={() => submitApiKey(provider)}
                                  disabled={connectingProvider !== provider.id || !apiKeyInput.trim()}
                                  className="px-4 py-2 bg-accent text-white text-sm font-medium rounded-md hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                  Connect
                                </button>
                              </div>
                              {provider.apiKeyUrl && (
                                <div className="text-xs text-text-muted">
                                  Get your API key from{' '}
                                  <a
                                    href={provider.apiKeyUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-accent hover:underline"
                                  >
                                    {new URL(provider.apiKeyUrl).hostname}
                                  </a>
                                </div>
                              )}
                              <button
                                onClick={() => setShowApiKeyFallback(prev => ({ ...prev, [provider.id]: false }))}
                                className="text-xs text-text-muted hover:text-text-secondary"
                              >
                                ← Back to OAuth login
                              </button>
                            </div>
                          ) : (
                            /* Primary connect button */
                            <div className="space-y-2">
                              <button
                                onClick={() => startOAuthFlow(provider)}
                                disabled={connectingProvider !== null}
                                className="w-full py-2.5 px-4 bg-accent text-white text-sm font-medium rounded-md hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                              >
                                <span>🔐</span>
                                Connect with {provider.displayName}
                              </button>
                              {provider.apiKeyUrl && (
                                <button
                                  onClick={() => setShowApiKeyFallback(prev => ({ ...prev, [provider.id]: true }))}
                                  className="w-full text-xs text-text-muted hover:text-text-secondary"
                                >
                                  Or enter API key manually
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      <div className="mt-2 text-xs text-text-dim">
                        CLI: <code className="px-1 py-0.5 bg-bg-tertiary rounded">{provider.cliCommand}</code>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'trajectories' && (
            <div className="flex flex-col gap-6">
              {trajectorySettings.loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-text-muted">Loading settings...</div>
                </div>
              ) : trajectorySettings.error ? (
                <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-red-400 text-sm">{trajectorySettings.error}</p>
                  <button
                    className="mt-2 text-sm text-accent hover:underline"
                    onClick={fetchTrajectorySettings}
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <>
                  {/* Documentation section */}
                  <div className="p-4 bg-gradient-to-r from-accent/10 to-accent/5 border border-accent/20 rounded-lg">
                    <h3 className="text-base font-semibold text-text-primary mb-2 flex items-center gap-2">
                      <TrajectoryIcon />
                      What are Trajectories?
                    </h3>
                    <p className="text-sm text-text-secondary mb-3">
                      {trajectorySettings.documentation?.description ||
                        'Trajectories record the journey of agent work using the PDERO paradigm (Plan, Design, Execute, Review, Observe). They capture decisions, phase transitions, and retrospectives.'}
                    </p>
                    <div className="mb-3">
                      <h4 className="text-xs font-semibold text-text-muted uppercase mb-2">Benefits</h4>
                      <ul className="list-none p-0 m-0 space-y-1.5">
                        {(trajectorySettings.documentation?.benefits || [
                          'Track why decisions were made, not just what was built',
                          'Enable session recovery when agents crash',
                          'Provide learning data for future agents',
                          'Create audit trails of AI work',
                        ]).map((benefit, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-text-secondary">
                            <span className="text-accent">✓</span>
                            {benefit}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <a
                      href={trajectorySettings.documentation?.learnMore || 'https://pdero.com'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
                    >
                      Learn more about PDERO
                      <ExternalLinkIcon />
                    </a>
                  </div>

                  {/* Settings */}
                  <div className="flex flex-col gap-3">
                    <label className="text-xs font-semibold text-text-muted uppercase tracking-[0.5px]">
                      Storage Settings
                    </label>

                    <ToggleOption
                      label="Store trajectories in repository"
                      description={trajectorySettings.documentation?.storeInRepoExplanation ||
                        'When enabled, trajectories are saved to .trajectories/ in your repo and can be committed to source control.'}
                      checked={trajectorySettings.storeInRepo}
                      onChange={(v) => updateTrajectorySettings(v)}
                    />

                    <div className="p-3 bg-bg-hover rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-text-primary">Current storage location</span>
                      </div>
                      <code className="text-xs text-text-muted bg-bg-tertiary px-2 py-1 rounded">
                        {trajectorySettings.storageLocation || 'user (~/.config/agent-relay/trajectories/)'}
                      </code>
                    </div>
                  </div>

                  {/* Why opt-in info */}
                  <div className="p-3 bg-bg-hover rounded-lg border border-border">
                    <h4 className="text-sm font-medium text-text-primary mb-1">Why opt-in to repo storage?</h4>
                    <p className="text-xs text-text-muted">
                      Teams who want to review agent decision-making processes can store trajectories
                      in the repo to version control them alongside code. This makes it easy to understand
                      why agents made specific choices during code review.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between py-4 px-6 border-t border-border">
          {onResetSettings && (
            <button
              className="py-2 px-4 bg-transparent border border-border rounded-md text-[13px] text-text-secondary cursor-pointer font-[inherit] transition-all duration-150 hover:bg-bg-hover hover:text-text-primary"
              onClick={onResetSettings}
            >
              Reset to defaults
            </button>
          )}
          <button
            className="py-2 px-5 bg-accent border-none rounded-md text-[13px] font-medium text-white cursor-pointer font-[inherit] transition-colors duration-150 hover:bg-accent-hover"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

interface ToggleOptionProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

function ToggleOption({ label, description, checked, onChange, disabled }: ToggleOptionProps) {
  return (
    <div className={`flex items-center justify-between p-3 bg-bg-hover rounded-lg ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-muted">{description}</span>
      </div>
      <button
        className={`w-11 h-6 border-none rounded-xl cursor-pointer relative transition-colors duration-200 ${
          checked ? 'bg-accent' : 'bg-border-medium'
        } ${disabled ? 'cursor-not-allowed' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        role="switch"
        aria-checked={checked}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.2)] ${
            checked ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </div>
  );
}

// Icon components
function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="13.5" cy="6.5" r=".5" />
      <circle cx="17.5" cy="10.5" r=".5" />
      <circle cx="8.5" cy="7.5" r=".5" />
      <circle cx="6.5" cy="12.5" r=".5" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function ProviderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function TrajectoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
