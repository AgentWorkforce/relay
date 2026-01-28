/**
 * Add Workspace Modal
 *
 * Modal dialog for adding a new workspace (repository) to the orchestrator.
 */

import React, { useState, useEffect, useRef } from 'react';

export interface AddWorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (path: string, name?: string) => Promise<void>;
  isAdding?: boolean;
  error?: string | null;
}

export function AddWorkspaceModal({
  isOpen,
  onClose,
  onAdd,
  isAdding = false,
  error,
}: AddWorkspaceModalProps) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Reset form when modal closes
  useEffect(() => {
    if (!isOpen) {
      setPath('');
      setName('');
      setLocalError(null);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!path.trim()) {
      setLocalError('Path is required');
      return;
    }

    try {
      await onAdd(path.trim(), name.trim() || undefined);
      onClose();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to add workspace');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  const displayError = error || localError;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="bg-[#1a1a2e] border border-[#3a3a4e] rounded-xl p-6 min-w-[450px] max-w-[90vw] shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="m-0 text-lg font-semibold text-[#e8e8e8]">Add Workspace</h2>
          <button
            className="bg-transparent border-none text-[#666] cursor-pointer p-1 flex items-center justify-center rounded transition-all hover:bg-white/10 hover:text-[#e8e8e8]"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label htmlFor="workspace-path" className="block mb-2 text-[13px] font-medium text-[#e8e8e8]">
              Repository Path
            </label>
            <input
              ref={inputRef}
              id="workspace-path"
              type="text"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setLocalError(null);
              }}
              placeholder="/path/to/repository"
              disabled={isAdding}
              autoComplete="off"
              className="w-full px-3 py-2.5 bg-[#2a2a3e] border border-[#3a3a4e] rounded-md text-[#e8e8e8] text-sm outline-none transition-colors box-border focus:border-[#00c896] placeholder:text-[#666] disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p className="mt-1.5 text-xs text-[#666] leading-relaxed">
              Enter the full path to your repository. Use ~ for home directory.
            </p>
          </div>

          <div className="mb-5">
            <label htmlFor="workspace-name" className="block mb-2 text-[13px] font-medium text-[#e8e8e8]">
              Display Name (optional)
            </label>
            <input
              id="workspace-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              disabled={isAdding}
              autoComplete="off"
              className="w-full px-3 py-2.5 bg-[#2a2a3e] border border-[#3a3a4e] rounded-md text-[#e8e8e8] text-sm outline-none transition-colors box-border focus:border-[#00c896] placeholder:text-[#666] disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p className="mt-1.5 text-xs text-[#666] leading-relaxed">
              A friendly name for this workspace. Defaults to the folder name.
            </p>
          </div>

          {displayError && (
            <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-md text-red-500 text-[13px] mb-5">
              {displayError}
            </div>
          )}

          <div className="flex gap-3 justify-end mt-6">
            <button
              type="button"
              className="px-5 py-2.5 rounded-md text-sm font-medium cursor-pointer transition-all bg-transparent border border-[#3a3a4e] text-[#e8e8e8] hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onClose}
              disabled={isAdding}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 rounded-md text-sm font-medium cursor-pointer transition-all bg-[#00c896] border-none text-[#1a1a2e] hover:bg-[#00a87d] disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isAdding || !path.trim()}
            >
              {isAdding ? 'Adding...' : 'Add Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
