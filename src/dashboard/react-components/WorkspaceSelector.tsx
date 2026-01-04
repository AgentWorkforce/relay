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
  onWorkspaceSettings?: () => void;
  isLoading?: boolean;
}

export function WorkspaceSelector({
  workspaces,
  activeWorkspaceId,
  onSelect,
  onAddWorkspace,
  onWorkspaceSettings,
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
    <div className="relative w-full" ref={dropdownRef}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-[#2a2a3e] border border-[#3a3a4e] rounded-lg text-[#e8e8e8] text-sm cursor-pointer transition-all hover:bg-[#3a3a4e] hover:border-[#4a4a5e] disabled:opacity-60 disabled:cursor-not-allowed"
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
      >
        {isLoading ? (
          <span className="flex-1 text-left text-[#666]">Loading...</span>
        ) : activeWorkspace ? (
          <>
            <ProviderIcon provider={activeWorkspace.provider} />
            <span className="flex-1 text-left font-medium">{activeWorkspace.name}</span>
            {activeWorkspace.gitBranch && (
              <span className="flex items-center gap-1 text-xs text-[#888] bg-white/5 px-1.5 py-0.5 rounded">
                <BranchIcon />
                {activeWorkspace.gitBranch}
              </span>
            )}
          </>
        ) : (
          <span className="flex-1 text-left text-[#666]">Select workspace...</span>
        )}
        <ChevronIcon isOpen={isOpen} />
      </button>

      {isOpen && (
        <div className="absolute top-[calc(100%+4px)] left-0 right-0 bg-[#1a1a2e] border border-[#3a3a4e] rounded-lg shadow-[0_10px_40px_rgba(0,0,0,0.4)] z-[1000] overflow-hidden">
          <div className="max-h-[300px] overflow-y-auto">
            {workspaces.length === 0 ? (
              <div className="py-6 px-4 text-center text-[#666] text-[13px] leading-relaxed">
                No workspaces added yet.
                <br />
                Add a repository to get started.
              </div>
            ) : (
              workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 bg-transparent border-none text-[#e8e8e8] text-sm cursor-pointer transition-colors text-left hover:bg-white/5 ${
                    workspace.id === activeWorkspaceId ? 'bg-[rgba(0,200,150,0.1)]' : ''
                  }`}
                  onClick={() => {
                    onSelect(workspace);
                    setIsOpen(false);
                  }}
                >
                  <ProviderIcon provider={workspace.provider} />
                  <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium">{workspace.name}</span>
                    <span className="text-[11px] text-[#666] overflow-hidden text-ellipsis whitespace-nowrap">
                      {workspace.path}
                    </span>
                  </div>
                  <StatusIndicator status={workspace.status} />
                </button>
              ))
            )}
          </div>

          <div className="p-2 border-t border-[#3a3a4e] space-y-1.5">
            {onWorkspaceSettings && activeWorkspace && (
              <button
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-transparent border border-[#3a3a4e] rounded-md text-[#888] text-[13px] cursor-pointer transition-all hover:bg-white/5 hover:border-[#4a4a5e] hover:text-[#e8e8e8]"
                onClick={() => {
                  onWorkspaceSettings();
                  setIsOpen(false);
                }}
              >
                <SettingsIcon />
                Workspace Settings
              </button>
            )}
            <button
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-transparent border border-dashed border-[#3a3a4e] rounded-md text-[#888] text-[13px] cursor-pointer transition-all hover:bg-white/5 hover:border-[#4a4a5e] hover:text-[#e8e8e8]"
              onClick={onAddWorkspace}
            >
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
    <span className="text-base" title={provider}>
      {icons[provider] || icons.generic}
    </span>
  );
}

function StatusIndicator({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-500',
    inactive: 'bg-gray-500',
    error: 'bg-red-500',
  };

  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${colors[status] || colors.inactive}`}
      title={status}
    />
  );
}

function ChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      className={`text-[#666] transition-transform ${isOpen ? 'rotate-180' : ''}`}
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

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
