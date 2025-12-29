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

export interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSettingsChange: (settings: Settings) => void;
  onResetSettings?: () => void;
}

export function SettingsPanel({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  onResetSettings,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'appearance' | 'notifications' | 'connection'>('appearance');

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
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${activeTab === 'appearance' ? 'active' : ''}`}
            onClick={() => setActiveTab('appearance')}
          >
            <PaletteIcon />
            Appearance
          </button>
          <button
            className={`settings-tab ${activeTab === 'notifications' ? 'active' : ''}`}
            onClick={() => setActiveTab('notifications')}
          >
            <BellIcon />
            Notifications
          </button>
          <button
            className={`settings-tab ${activeTab === 'connection' ? 'active' : ''}`}
            onClick={() => setActiveTab('connection')}
          >
            <WifiIcon />
            Connection
          </button>
        </div>

        <div className="settings-content">
          {activeTab === 'appearance' && (
            <div className="settings-section">
              <div className="settings-group">
                <label className="settings-label">Theme</label>
                <div className="settings-theme-options">
                  {(['light', 'dark', 'system'] as const).map((theme) => (
                    <button
                      key={theme}
                      className={`settings-theme-btn ${settings.theme === theme ? 'active' : ''}`}
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

              <div className="settings-group">
                <label className="settings-label">Display Options</label>
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
            <div className="settings-section">
              <div className="settings-group">
                <label className="settings-label">Notification Preferences</label>
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
            <div className="settings-section">
              <div className="settings-group">
                <label className="settings-label">Connection Settings</label>
                <ToggleOption
                  label="Auto-reconnect"
                  description="Automatically reconnect on disconnect"
                  checked={settings.connection.autoReconnect}
                  onChange={(v) => updateSetting('connection', 'autoReconnect', v)}
                />

                <div className="settings-input-group">
                  <label>Reconnect delay (ms)</label>
                  <input
                    type="number"
                    className="settings-input"
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

                <div className="settings-input-group">
                  <label>Keep-alive interval (ms)</label>
                  <input
                    type="number"
                    className="settings-input"
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
        </div>

        <div className="settings-footer">
          {onResetSettings && (
            <button className="settings-reset-btn" onClick={onResetSettings}>
              Reset to defaults
            </button>
          )}
          <button className="settings-done-btn" onClick={onClose}>
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
    <div className={`settings-toggle-option ${disabled ? 'disabled' : ''}`}>
      <div className="settings-toggle-info">
        <span className="settings-toggle-label">{label}</span>
        <span className="settings-toggle-desc">{description}</span>
      </div>
      <button
        className={`settings-toggle ${checked ? 'on' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        role="switch"
        aria-checked={checked}
      >
        <span className="settings-toggle-thumb" />
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

/**
 * CSS styles for the settings panel
 */
export const settingsPanelStyles = `
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.15s ease;
}

.settings-panel {
  background: #ffffff;
  border-radius: 12px;
  width: 500px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 70px rgba(0, 0, 0, 0.2);
  animation: slideUp 0.2s ease;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid #e8e8e8;
}

.settings-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.settings-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: #666;
  cursor: pointer;
  transition: all 0.15s;
}

.settings-close:hover {
  background: #f5f5f5;
  color: #333;
}

.settings-tabs {
  display: flex;
  gap: 4px;
  padding: 12px 24px;
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
}

.settings-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.settings-tab:hover {
  background: #f0f0f0;
  color: #333;
}

.settings-tab.active {
  background: #1264a3;
  color: #ffffff;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-label {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.settings-theme-options {
  display: flex;
  gap: 8px;
}

.settings-theme-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 20px;
  background: #fafafa;
  border: 2px solid transparent;
  border-radius: 8px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  flex: 1;
}

.settings-theme-btn:hover {
  background: #f0f0f0;
}

.settings-theme-btn.active {
  background: #e8f4fd;
  border-color: #1264a3;
  color: #1264a3;
}

.settings-toggle-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: #fafafa;
  border-radius: 8px;
}

.settings-toggle-option.disabled {
  opacity: 0.5;
}

.settings-toggle-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-toggle-label {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.settings-toggle-desc {
  font-size: 12px;
  color: #888;
}

.settings-toggle {
  width: 44px;
  height: 24px;
  background: #d0d0d0;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  position: relative;
  transition: background 0.2s;
}

.settings-toggle.on {
  background: #1264a3;
}

.settings-toggle:disabled {
  cursor: not-allowed;
}

.settings-toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  background: #ffffff;
  border-radius: 50%;
  transition: transform 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.settings-toggle.on .settings-toggle-thumb {
  transform: translateX(20px);
}

.settings-input-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: #fafafa;
  border-radius: 8px;
}

.settings-input-group label {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.settings-input {
  padding: 8px 12px;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}

.settings-input:focus {
  border-color: #1264a3;
}

.settings-input:disabled {
  background: #f5f5f5;
  color: #888;
}

.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-top: 1px solid #e8e8e8;
}

.settings-reset-btn {
  padding: 8px 16px;
  background: transparent;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.settings-reset-btn:hover {
  background: #f5f5f5;
  color: #333;
}

.settings-done-btn {
  padding: 8px 20px;
  background: #1264a3;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  color: #ffffff;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.settings-done-btn:hover {
  background: #0d4f82;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
`;
