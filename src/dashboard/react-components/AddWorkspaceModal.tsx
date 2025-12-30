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
    <div className="modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="modal add-workspace-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Workspace</h2>
          <button className="modal-close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="workspace-path">Repository Path</label>
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
            />
            <p className="form-hint">
              Enter the full path to your repository. Use ~ for home directory.
            </p>
          </div>

          <div className="form-group">
            <label htmlFor="workspace-name">Display Name (optional)</label>
            <input
              id="workspace-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              disabled={isAdding}
              autoComplete="off"
            />
            <p className="form-hint">
              A friendly name for this workspace. Defaults to the folder name.
            </p>
          </div>

          {displayError && <div className="form-error">{displayError}</div>}

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isAdding}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={isAdding || !path.trim()}>
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

export const addWorkspaceModalStyles = `
.add-workspace-modal {
  min-width: 450px;
  max-width: 90vw;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #e8e8e8;
}

.modal-close {
  background: transparent;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.modal-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e8e8e8;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 500;
  color: #e8e8e8;
}

.form-group input {
  width: 100%;
  padding: 10px 12px;
  background: #2a2a3e;
  border: 1px solid #3a3a4e;
  border-radius: 6px;
  color: #e8e8e8;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.form-group input:focus {
  border-color: #00c896;
}

.form-group input::placeholder {
  color: #666;
}

.form-group input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.form-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #666;
  line-height: 1.4;
}

.form-error {
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #ef4444;
  font-size: 13px;
  margin-bottom: 20px;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn-secondary,
.btn-primary {
  padding: 10px 20px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-secondary {
  background: transparent;
  border: 1px solid #3a3a4e;
  color: #e8e8e8;
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
}

.btn-primary {
  background: #00c896;
  border: none;
  color: #1a1a2e;
}

.btn-primary:hover:not(:disabled) {
  background: #00a87d;
}

.btn-secondary:disabled,
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`;
