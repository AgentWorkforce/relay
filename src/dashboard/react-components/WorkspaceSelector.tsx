/**
 * Workspace Selector Component
 *
 * Dropdown/list for switching between workspaces (repositories).
 * Connects to the orchestrator API for workspace management.
 */

import React, { useState, useRef, useEffect } from 'react';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  status: 'active' | 'inactive' | 'error';
  provider: 'claude' | 'codex' | 'gemini' | 'generic';
  gitBranch?: string;
  gitRemote?: string;
  lastActiveAt: Date;
}

export interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  onSelect: (workspace: Workspace) => void;
  onAddWorkspace: () => void;
  isLoading?: boolean;
}

export function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSelect,
  onAddWorkspace,
  isLoading = false,
}: WorkspaceSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  return (
    <div className="workspace-selector" ref={dropdownRef}>
      <button
        className="workspace-trigger"
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
      >
        {isLoading ? (
          <span className="workspace-loading">Loading...</span>
        ) : activeWorkspace ? (
          <>
            <ProviderIcon provider={activeWorkspace.provider} />
            <span className="workspace-name">{activeWorkspace.name}</span>
            {activeWorkspace.gitBranch && (
              <span className="workspace-branch">
                <BranchIcon />
                {activeWorkspace.gitBranch}
              </span>
            )}
          </>
        ) : (
          <span className="workspace-placeholder">Select workspace...</span>
        )}
        <ChevronIcon isOpen={isOpen} />
      </button>

      {isOpen && (
        <div className="workspace-dropdown">
          <div className="workspace-list">
            {workspaces.length === 0 ? (
              <div className="workspace-empty">
                No workspaces added yet.
                <br />
                Add a repository to get started.
              </div>
            ) : (
              workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={`workspace-item ${workspace.id === activeWorkspaceId ? 'active' : ''}`}
                  onClick={() => {
                    onSelect(workspace);
                    setIsOpen(false);
                  }}
                >
                  <ProviderIcon provider={workspace.provider} />
                  <div className="workspace-item-info">
                    <span className="workspace-item-name">{workspace.name}</span>
                    <span className="workspace-item-path">{workspace.path}</span>
                  </div>
                  <StatusIndicator status={workspace.status} />
                </button>
              ))
            )}
          </div>

          <div className="workspace-actions">
            <button className="workspace-add-btn" onClick={onAddWorkspace}>
              <PlusIcon />
              Add Workspace
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  const icons: Record<string, string> = {
    claude: '🤖',
    codex: '🧠',
    gemini: '✨',
    generic: '📁',
  };

  return (
    <span className="provider-icon" title={provider}>
      {icons[provider] || icons.generic}
    </span>
  );
}

function StatusIndicator({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: '#22c55e',
    inactive: '#6b7280',
    error: '#ef4444',
  };

  return (
    <span
      className="status-indicator"
      style={{ backgroundColor: colors[status] || colors.inactive }}
      title={status}
    />
  );
}

function ChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      className={`chevron-icon ${isOpen ? 'open' : ''}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export const workspaceSelectorStyles = `
.workspace-selector {
  position: relative;
  width: 100%;
}

.workspace-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: #2a2a3e;
  border: 1px solid #3a3a4e;
  border-radius: 8px;
  color: #e8e8e8;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.workspace-trigger:hover {
  background: #3a3a4e;
  border-color: #4a4a5e;
}

.workspace-trigger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.provider-icon {
  font-size: 16px;
}

.workspace-name {
  flex: 1;
  text-align: left;
  font-weight: 500;
}

.workspace-branch {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #888;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 6px;
  border-radius: 4px;
}

.workspace-placeholder {
  flex: 1;
  text-align: left;
  color: #666;
}

.workspace-loading {
  flex: 1;
  text-align: left;
  color: #666;
}

.chevron-icon {
  color: #666;
  transition: transform 0.2s;
}

.chevron-icon.open {
  transform: rotate(180deg);
}

.workspace-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: #1a1a2e;
  border: 1px solid #3a3a4e;
  border-radius: 8px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
  z-index: 1000;
  overflow: hidden;
}

.workspace-list {
  max-height: 300px;
  overflow-y: auto;
}

.workspace-empty {
  padding: 24px 16px;
  text-align: center;
  color: #666;
  font-size: 13px;
  line-height: 1.5;
}

.workspace-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: transparent;
  border: none;
  color: #e8e8e8;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
  text-align: left;
}

.workspace-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.workspace-item.active {
  background: rgba(0, 200, 150, 0.1);
}

.workspace-item-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.workspace-item-name {
  font-weight: 500;
}

.workspace-item-path {
  font-size: 11px;
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.workspace-actions {
  padding: 8px;
  border-top: 1px solid #3a3a4e;
}

.workspace-add-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  background: transparent;
  border: 1px dashed #3a3a4e;
  border-radius: 6px;
  color: #888;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.workspace-add-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: #4a4a5e;
  color: #e8e8e8;
}
`;
