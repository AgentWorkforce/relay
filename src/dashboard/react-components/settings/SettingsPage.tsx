/**
 * Unified Settings Page
 *
 * Full-page settings view with tabbed navigation for:
 * - Dashboard Settings (personal preferences)
 * - Workspace Settings (repos, providers, domains)
 * - Team Settings (members, invitations)
 * - Billing Settings (subscription, plans)
 *
 * Design: Mission Control theme - deep space aesthetic with cyan/purple accents
 */

import React, { useState, useEffect } from 'react';
import { cloudApi, getCsrfToken } from '../../lib/cloudApi';
import { WorkspaceSettingsPanel } from './WorkspaceSettingsPanel';
import { TeamSettingsPanel } from './TeamSettingsPanel';
import { BillingSettingsPanel } from './BillingSettingsPanel';

export interface SettingsPageProps {
  /** Current user ID for team membership checks */
  currentUserId?: string;
  /** Initial tab to show */
  initialTab?: 'dashboard' | 'workspace' | 'team' | 'billing';
  /** Callback when settings page is closed */
  onClose?: () => void;
}

interface WorkspaceSummary {
  id: string;
  name: string;
  status: string;
}

interface DashboardSettings {
  theme: 'dark' | 'light' | 'system';
  compactMode: boolean;
  showTimestamps: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  autoScrollMessages: boolean;
}

const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  theme: 'dark',
  compactMode: false,
  showTimestamps: true,
  soundEnabled: true,
  notificationsEnabled: true,
  autoScrollMessages: true,
};

export function SettingsPage({
  currentUserId,
  initialTab = 'dashboard',
  onClose,
}: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'workspace' | 'team' | 'billing'>(initialTab);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [isLoadingWorkspaces, setIsLoadingWorkspaces] = useState(true);
  const [dashboardSettings, setDashboardSettings] = useState<DashboardSettings>(DEFAULT_DASHBOARD_SETTINGS);

  // Load workspaces
  useEffect(() => {
    async function loadWorkspaces() {
      setIsLoadingWorkspaces(true);
      const result = await cloudApi.getWorkspaceSummary();
      if (result.success && result.data.workspaces.length > 0) {
        setWorkspaces(result.data.workspaces);
        setSelectedWorkspaceId(result.data.workspaces[0].id);
      }
      setIsLoadingWorkspaces(false);
    }
    loadWorkspaces();
  }, []);

  // Load dashboard settings from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('dashboard-settings');
    if (saved) {
      try {
        setDashboardSettings({ ...DEFAULT_DASHBOARD_SETTINGS, ...JSON.parse(saved) });
      } catch {
        // Use defaults
      }
    }
  }, []);

  // Save dashboard settings
  const updateDashboardSetting = <K extends keyof DashboardSettings>(
    key: K,
    value: DashboardSettings[K]
  ) => {
    const newSettings = { ...dashboardSettings, [key]: value };
    setDashboardSettings(newSettings);
    localStorage.setItem('dashboard-settings', JSON.stringify(newSettings));

    // Apply theme immediately
    if (key === 'theme') {
      document.documentElement.setAttribute('data-theme', value as string);
    }
  };

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
    { id: 'workspace', label: 'Workspace', icon: <WorkspaceIcon /> },
    { id: 'team', label: 'Team', icon: <TeamIcon /> },
    { id: 'billing', label: 'Billing', icon: <BillingIcon /> },
  ] as const;

  return (
    <div className="fixed inset-0 z-50 bg-bg-deep">
      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-30">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(0,217,255,0.08)_0%,_transparent_50%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_rgba(168,85,247,0.06)_0%,_transparent_50%)]" />
      </div>

      <div className="relative h-full flex flex-col">
        {/* Header */}
        <header className="h-14 md:h-16 px-4 md:px-6 flex items-center justify-between border-b border-border-subtle bg-bg-secondary/80 backdrop-blur-sm">
          <div className="flex items-center gap-3 md:gap-4">
            <div className="w-8 h-8 md:w-10 md:h-10 rounded-xl bg-gradient-to-br from-accent-cyan to-accent-purple flex items-center justify-center shadow-lg shadow-accent-cyan/20">
              <SettingsIcon className="text-white w-4 h-4 md:w-[18px] md:h-[18px]" />
            </div>
            <div>
              <h1 className="text-base md:text-lg font-bold text-text-primary tracking-tight">Settings</h1>
              <p className="text-[10px] md:text-xs text-text-muted hidden sm:block">Manage your workspace and preferences</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-9 h-9 md:w-10 md:h-10 rounded-lg bg-bg-tertiary border border-border-subtle flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <CloseIcon />
          </button>
        </header>

        {/* Mobile Tab Navigation */}
        <div className="md:hidden flex border-b border-border-subtle bg-bg-secondary/50 overflow-x-auto scrollbar-hide">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 min-w-[80px] flex flex-col items-center gap-1 px-3 py-3 text-xs font-medium transition-all ${
                activeTab === tab.id
                  ? 'text-accent-cyan border-b-2 border-accent-cyan bg-accent-cyan/5'
                  : 'text-text-muted border-b-2 border-transparent'
              }`}
            >
              <span className={activeTab === tab.id ? 'text-accent-cyan' : 'text-text-muted'}>
                {tab.icon}
              </span>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Mobile Workspace Selector */}
        {(activeTab === 'workspace' || activeTab === 'team') && workspaces.length > 0 && (
          <div className="md:hidden px-4 py-2 border-b border-border-subtle bg-bg-tertiary/50">
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full shrink-0 ${
                  workspaces.find(ws => ws.id === selectedWorkspaceId)?.status === 'running'
                    ? 'bg-success'
                    : workspaces.find(ws => ws.id === selectedWorkspaceId)?.status === 'stopped'
                    ? 'bg-amber-400'
                    : 'bg-text-muted'
                }`}
              />
              {workspaces.length === 1 ? (
                <span className="text-sm text-text-primary">{workspaces[0].name}</span>
              ) : (
                <select
                  value={selectedWorkspaceId || ''}
                  onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                  className="flex-1 px-3 py-2 bg-bg-card border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
                >
                  {workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>{ws.name}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Desktop Sidebar Navigation */}
          <nav className="hidden md:flex w-64 border-r border-border-subtle bg-bg-secondary/50 p-4 flex-col">
            <div className="space-y-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 ${
                    activeTab === tab.id
                      ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30 shadow-[0_0_20px_rgba(0,217,255,0.1)]'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                  }`}
                >
                  <span className={activeTab === tab.id ? 'text-accent-cyan' : 'text-text-muted'}>
                    {tab.icon}
                  </span>
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Workspace Selector (shown on workspace/team tabs) */}
            {(activeTab === 'workspace' || activeTab === 'team') && workspaces.length > 0 && (
              <div className="mt-8 pt-6 border-t border-border-subtle">
                <label className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 block">
                  Select Workspace
                </label>
                <div className="space-y-2">
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      onClick={() => setSelectedWorkspaceId(ws.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                        selectedWorkspaceId === ws.id
                          ? 'bg-bg-tertiary border border-accent-cyan/30 text-text-primary'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
                      }`}
                    >
                      <div
                        className={`w-2 h-2 rounded-full ${
                          ws.status === 'running'
                            ? 'bg-success'
                            : ws.status === 'stopped'
                            ? 'bg-amber-400'
                            : 'bg-text-muted'
                        }`}
                      />
                      <span className="truncate">{ws.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Version info at bottom */}
            <div className="mt-auto pt-6">
              <div className="px-4 py-3 bg-bg-tertiary/50 rounded-lg">
                <p className="text-xs text-text-muted">Agent Relay</p>
                <p className="text-xs font-mono text-text-muted/60">v1.0.0</p>
              </div>
            </div>
          </nav>

          {/* Main Content */}
          <main className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto p-4 md:p-8">
              {/* Dashboard Settings */}
              {activeTab === 'dashboard' && (
                <div className="space-y-8">
                  <PageHeader
                    title="Dashboard Settings"
                    subtitle="Customize your dashboard experience"
                  />

                  {/* Appearance */}
                  <SettingsSection title="Appearance" icon={<PaletteIcon />}>
                    <SettingRow
                      label="Theme"
                      description="Choose your preferred color scheme"
                    >
                      <select
                        value={dashboardSettings.theme}
                        onChange={(e) => updateDashboardSetting('theme', e.target.value as DashboardSettings['theme'])}
                        className="px-4 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent-cyan"
                      >
                        <option value="dark">Dark</option>
                        <option value="light">Light</option>
                        <option value="system">System</option>
                      </select>
                    </SettingRow>

                    <SettingRow
                      label="Compact Mode"
                      description="Reduce spacing and show more content"
                    >
                      <Toggle
                        checked={dashboardSettings.compactMode}
                        onChange={(v) => updateDashboardSetting('compactMode', v)}
                      />
                    </SettingRow>

                    <SettingRow
                      label="Show Timestamps"
                      description="Display timestamps on messages"
                    >
                      <Toggle
                        checked={dashboardSettings.showTimestamps}
                        onChange={(v) => updateDashboardSetting('showTimestamps', v)}
                      />
                    </SettingRow>
                  </SettingsSection>

                  {/* Notifications */}
                  <SettingsSection title="Notifications" icon={<BellIcon />}>
                    <SettingRow
                      label="Sound Effects"
                      description="Play sounds for new messages"
                    >
                      <Toggle
                        checked={dashboardSettings.soundEnabled}
                        onChange={(v) => updateDashboardSetting('soundEnabled', v)}
                      />
                    </SettingRow>

                    <SettingRow
                      label="Browser Notifications"
                      description="Show desktop notifications"
                    >
                      <Toggle
                        checked={dashboardSettings.notificationsEnabled}
                        onChange={(v) => updateDashboardSetting('notificationsEnabled', v)}
                      />
                    </SettingRow>
                  </SettingsSection>

                  {/* Behavior */}
                  <SettingsSection title="Behavior" icon={<SettingsIcon />}>
                    <SettingRow
                      label="Auto-scroll Messages"
                      description="Automatically scroll to new messages"
                    >
                      <Toggle
                        checked={dashboardSettings.autoScrollMessages}
                        onChange={(v) => updateDashboardSetting('autoScrollMessages', v)}
                      />
                    </SettingRow>
                  </SettingsSection>
                </div>
              )}

              {/* Workspace Settings */}
              {activeTab === 'workspace' && (
                <>
                  {isLoadingWorkspaces ? (
                    <div className="flex items-center justify-center h-64">
                      <div className="relative">
                        <div className="w-12 h-12 rounded-full border-2 border-accent-cyan/20 border-t-accent-cyan animate-spin" />
                      </div>
                      <span className="ml-4 text-text-muted">Loading workspaces...</span>
                    </div>
                  ) : selectedWorkspaceId ? (
                    <WorkspaceSettingsPanel
                      workspaceId={selectedWorkspaceId}
                      csrfToken={getCsrfToken() || undefined}
                      onClose={onClose}
                    />
                  ) : (
                    <EmptyState
                      icon={<WorkspaceIcon />}
                      title="No Workspace"
                      description="Create a workspace to get started with Agent Relay."
                      action={
                        <button className="px-6 py-3 bg-accent-cyan text-bg-deep font-semibold rounded-lg hover:bg-accent-cyan/90 transition-colors">
                          Create Workspace
                        </button>
                      }
                    />
                  )}
                </>
              )}

              {/* Team Settings */}
              {activeTab === 'team' && (
                <>
                  {selectedWorkspaceId ? (
                    <div className="space-y-8">
                      <PageHeader
                        title="Team Settings"
                        subtitle="Manage workspace members and permissions"
                      />
                      <TeamSettingsPanel
                        workspaceId={selectedWorkspaceId}
                        currentUserId={currentUserId}
                      />
                    </div>
                  ) : (
                    <EmptyState
                      icon={<TeamIcon />}
                      title="No Workspace Selected"
                      description="Select a workspace to manage team members."
                    />
                  )}
                </>
              )}

              {/* Billing Settings */}
              {activeTab === 'billing' && (
                <div className="space-y-8">
                  <PageHeader
                    title="Billing & Subscription"
                    subtitle="Manage your plan and payment methods"
                  />
                  <BillingSettingsPanel />
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// Utility Components
function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-8">
      <h2 className="text-2xl font-bold text-text-primary">{title}</h2>
      <p className="text-sm text-text-muted mt-1">{subtitle}</p>
    </div>
  );
}

function SettingsSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg-tertiary rounded-xl border border-border-subtle overflow-hidden">
      <div className="px-6 py-4 border-b border-border-subtle bg-bg-secondary/50 flex items-center gap-3">
        <span className="text-accent-cyan">{icon}</span>
        <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wide">{title}</h3>
      </div>
      <div className="divide-y divide-border-subtle">{children}</div>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-6 py-4 flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-muted mt-0.5">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-12 h-6 rounded-full transition-colors ${
        checked ? 'bg-accent-cyan' : 'bg-bg-hover'
      }`}
    >
      <span
        className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
          checked ? 'translate-x-7' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <div className="w-16 h-16 rounded-2xl bg-bg-tertiary flex items-center justify-center text-text-muted mb-4">
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-text-primary mb-2">{title}</h3>
      <p className="text-sm text-text-muted max-w-sm mb-6">{description}</p>
      {action}
    </div>
  );
}

// Icons
function SettingsIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function BillingIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
      <line x1="1" y1="10" x2="23" y2="10" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r="2.5" />
      <circle cx="19" cy="13.5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="11" cy="19" r="2.5" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
