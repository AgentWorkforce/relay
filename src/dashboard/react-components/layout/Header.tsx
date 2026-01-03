/**
 * Header Component - Mission Control Theme
 *
 * Top navigation bar with current context, quick actions,
 * and command palette trigger.
 */

import React from 'react';
import type { Agent, Project } from '../../types';
import { getAgentColor, getAgentInitials } from '../../lib/colors';
import { getAgentBreadcrumb } from '../../lib/hierarchy';
import { RepoContextHeader } from './RepoContextHeader';

export interface HeaderProps {
  currentChannel: string;
  selectedAgent?: Agent | null;
  /** Connected projects for multi-repo indicator */
  projects?: Project[];
  /** Currently active project */
  currentProject?: Project | null;
  /** Recently accessed projects for quick switching */
  recentProjects?: Project[];
  /** Callback when user switches project */
  onProjectChange?: (project: Project) => void;
  onCommandPaletteOpen?: () => void;
  onSettingsClick?: () => void;
  onHistoryClick?: () => void;
  onNewConversationClick?: () => void;
  onCoordinatorClick?: () => void;
  /** Fleet view toggle */
  onFleetClick?: () => void;
  /** Whether fleet view is currently active */
  isFleetViewActive?: boolean;
  /** Trajectory viewer toggle */
  onTrajectoryClick?: () => void;
  /** Whether there's an active trajectory */
  hasActiveTrajectory?: boolean;
  /** Mobile: open sidebar handler */
  onMenuClick?: () => void;
  /** Show notification badge on mobile menu button */
  hasUnreadNotifications?: boolean;
}

export function Header({
  currentChannel,
  selectedAgent,
  projects = [],
  currentProject,
  recentProjects = [],
  onProjectChange,
  onCommandPaletteOpen,
  onSettingsClick,
  onHistoryClick,
  onNewConversationClick,
  onCoordinatorClick,
  onFleetClick,
  isFleetViewActive,
  onTrajectoryClick,
  hasActiveTrajectory,
  onMenuClick,
  hasUnreadNotifications,
}: HeaderProps) {
  const isGeneral = currentChannel === 'general';
  const colors = selectedAgent ? getAgentColor(selectedAgent.name) : null;
  const hasMultipleProjects = projects.length > 1;

  return (
    <header className="h-[52px] bg-bg-secondary border-b border-border-subtle flex items-center justify-between px-4">
      {/* Mobile hamburger menu button */}
      <button
        className="hidden max-md:flex items-center justify-center w-11 h-11 bg-transparent border-none text-text-primary cursor-pointer rounded-lg transition-colors hover:bg-bg-hover relative"
        onClick={onMenuClick}
        aria-label="Open menu"
      >
        <MenuIcon />
        {hasUnreadNotifications && (
          <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-error rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
        )}
      </button>

      {/* Repo Context Switcher */}
      {projects.length > 0 && onProjectChange && (
        <div className="max-md:hidden mr-3">
          <RepoContextHeader
            projects={projects}
            recentProjects={recentProjects}
            currentProject={currentProject ?? null}
            onProjectChange={onProjectChange}
          />
        </div>
      )}

      {/* Divider when repo context is shown */}
      {projects.length > 0 && onProjectChange && (
        <div className="w-px h-6 bg-border-subtle mr-3 max-md:hidden" />
      )}

      <div className="flex items-center gap-3 flex-1 min-w-0">
        {isGeneral ? (
          <>
            <span className="text-accent-cyan text-lg font-mono">#</span>
            <span className="font-display font-semibold text-base text-text-primary max-md:max-w-[150px] max-md:truncate">general</span>
            <span className="text-text-muted text-sm ml-2 pl-3 border-l border-border-subtle max-md:hidden">
              All agent communications
            </span>
          </>
        ) : selectedAgent ? (
          <>
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-semibold text-xs border-2"
              style={{
                backgroundColor: colors?.primary,
                borderColor: colors?.primary,
                boxShadow: `0 0 12px ${colors?.primary}40`,
              }}
            >
              <span style={{ color: colors?.text }}>
                {getAgentInitials(selectedAgent.name)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="font-display font-semibold text-base text-text-primary max-md:max-w-[150px] max-md:truncate">
                {selectedAgent.name}
              </span>
              <span className="text-text-muted text-xs font-mono max-md:hidden">
                {getAgentBreadcrumb(selectedAgent.name)}
              </span>
            </div>
            {selectedAgent.status && (
              <span className={`text-xs py-1 px-2.5 rounded-full font-medium ml-2 ${
                selectedAgent.status === 'online'
                  ? 'bg-success/20 text-success'
                  : 'bg-bg-tertiary text-text-muted'
              }`}>
                {selectedAgent.status}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="text-accent-cyan text-lg font-mono">@</span>
            <span className="font-display font-semibold text-base text-text-primary">{currentChannel}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          className="flex items-center gap-2 py-2 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold border-none rounded-lg text-sm cursor-pointer transition-all duration-150 hover:shadow-glow-cyan hover:-translate-y-0.5"
          onClick={onNewConversationClick}
          title="Start new conversation (⌘N)"
        >
          <NewMessageIcon />
          <span className="max-md:hidden">New Message</span>
        </button>

        <button
          className="flex items-center gap-2 py-2 px-3 bg-bg-tertiary border border-border-subtle rounded-lg text-text-secondary text-sm cursor-pointer transition-all duration-150 hover:bg-bg-elevated hover:border-border-medium hover:text-text-primary"
          onClick={onCommandPaletteOpen}
          title="Command Palette (⌘K)"
        >
          <SearchIcon />
          <span className="max-md:hidden">Search</span>
          <kbd className="bg-bg-card border border-border-subtle rounded px-1.5 py-0.5 text-xs text-text-muted font-mono max-md:hidden">
            ⌘K
          </kbd>
        </button>

        <button
          className="flex items-center justify-center p-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-elevated hover:border-border-medium hover:text-accent-cyan"
          onClick={onHistoryClick}
          title="Message History"
        >
          <HistoryIcon />
        </button>

        {/* Coordinator button - shown when multiple projects are connected */}
        {hasMultipleProjects && (
          <button
            className="flex items-center justify-center p-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-elevated hover:border-border-medium hover:text-accent-purple"
            onClick={onCoordinatorClick}
            title="Coordinator Agent"
          >
            <CoordinatorIcon />
          </button>
        )}

        {/* Fleet Overview toggle */}
        {onFleetClick && (
          <button
            className={`flex items-center justify-center p-2 border rounded-lg cursor-pointer transition-all duration-150 ${
              isFleetViewActive
                ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan'
                : 'bg-bg-tertiary border-border-subtle text-text-secondary hover:bg-bg-elevated hover:border-border-medium hover:text-accent-cyan'
            }`}
            onClick={onFleetClick}
            title={isFleetViewActive ? 'Back to Chat' : 'Fleet Overview'}
          >
            <FleetIcon />
          </button>
        )}

        {/* Trajectory Viewer toggle */}
        {onTrajectoryClick && (
          <button
            className={`flex items-center justify-center p-2 border rounded-lg cursor-pointer transition-all duration-150 relative ${
              hasActiveTrajectory
                ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan'
                : 'bg-bg-tertiary border-border-subtle text-text-secondary hover:bg-bg-elevated hover:border-border-medium hover:text-accent-cyan'
            }`}
            onClick={onTrajectoryClick}
            title="Trajectory Viewer"
          >
            <TrajectoryIcon />
            {hasActiveTrajectory && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-accent-cyan rounded-full animate-pulse" />
            )}
          </button>
        )}

        <a
          href="/metrics"
          className="flex items-center justify-center p-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-elevated hover:border-border-medium hover:text-accent-orange no-underline"
          title="Fleet Metrics"
        >
          <MetricsIcon />
        </a>

        <button
          className="flex items-center justify-center p-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-elevated hover:border-border-medium hover:text-accent-purple"
          onClick={onSettingsClick}
          title="Settings"
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}

function NewMessageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
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

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
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
