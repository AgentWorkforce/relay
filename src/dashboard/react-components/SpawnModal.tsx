/**
 * SpawnModal Component
 *
 * Modal for spawning new agent instances with configuration options.
 * Supports different agent types (claude, codex, etc.) and naming conventions.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface SpawnConfig {
  name: string;
  command: string;
  cwd?: string;
  team?: string;
}

export interface SpawnModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSpawn: (config: SpawnConfig) => Promise<boolean>;
  existingAgents: string[];
  isSpawning?: boolean;
  error?: string | null;
}

const AGENT_TEMPLATES = [
  {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    description: 'Claude Code CLI agent',
    icon: '🤖',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    description: 'OpenAI Codex agent',
    icon: '⚡',
  },
  {
    id: 'custom',
    name: 'Custom',
    command: '',
    description: 'Custom command',
    icon: '🔧',
  },
];

const NAME_PREFIXES = [
  'frontend',
  'backend',
  'lead',
  'test',
  'docs',
  'review',
  'deploy',
  'data',
];

export function SpawnModal({
  isOpen,
  onClose,
  onSpawn,
  existingAgents,
  isSpawning = false,
  error,
}: SpawnModalProps) {
  const [selectedTemplate, setSelectedTemplate] = useState(AGENT_TEMPLATES[0]);
  const [name, setName] = useState('');
  const [customCommand, setCustomCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [team, setTeam] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Generate suggested name based on template and existing agents
  const suggestedName = useCallback(() => {
    const prefix = selectedTemplate.id === 'claude' ? 'claude' : selectedTemplate.id;
    let num = 1;
    while (existingAgents.includes(`${prefix}-${num}`)) {
      num++;
    }
    return `${prefix}-${num}`;
  }, [selectedTemplate, existingAgents]);

  // Reset form when opened
  useEffect(() => {
    if (isOpen) {
      setSelectedTemplate(AGENT_TEMPLATES[0]);
      setName('');
      setCustomCommand('');
      setCwd('');
      setTeam('');
      setLocalError(null);
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Validate name
  const validateName = useCallback(
    (value: string): string | null => {
      if (!value.trim()) {
        return 'Name is required';
      }
      if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(value)) {
        return 'Name must start with a letter and contain only letters, numbers, and hyphens';
      }
      if (existingAgents.includes(value)) {
        return 'An agent with this name already exists';
      }
      return null;
    },
    [existingAgents]
  );

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const finalName = name.trim() || suggestedName();
    const nameError = validateName(finalName);
    if (nameError) {
      setLocalError(nameError);
      return;
    }

    const command = selectedTemplate.id === 'custom' ? customCommand : selectedTemplate.command;
    if (!command.trim()) {
      setLocalError('Command is required');
      return;
    }

    setLocalError(null);
    const success = await onSpawn({
      name: finalName,
      command: command.trim(),
      cwd: cwd.trim() || undefined,
      team: team.trim() || undefined,
    });

    if (success) {
      onClose();
    }
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  const colors = name ? getAgentColor(name) : getAgentColor(suggestedName());
  const displayError = error || localError;

  return (
    <div className="spawn-modal-overlay" onClick={onClose}>
      <div
        className="spawn-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="spawn-modal-header">
          <h2>Spawn New Agent</h2>
          <button className="spawn-modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Agent Type Selection */}
          <div className="spawn-modal-section">
            <label className="spawn-modal-label">Agent Type</label>
            <div className="spawn-modal-templates">
              {AGENT_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={`spawn-modal-template ${
                    selectedTemplate.id === template.id ? 'selected' : ''
                  }`}
                  onClick={() => setSelectedTemplate(template)}
                >
                  <span className="spawn-modal-template-icon">{template.icon}</span>
                  <span className="spawn-modal-template-name">{template.name}</span>
                  <span className="spawn-modal-template-desc">{template.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Agent Name */}
          <div className="spawn-modal-section">
            <label className="spawn-modal-label" htmlFor="agent-name">
              Agent Name
            </label>
            <div className="spawn-modal-name-input">
              <div
                className="spawn-modal-name-preview"
                style={{ backgroundColor: colors.primary, color: colors.text }}
              >
                {getAgentInitials(name || suggestedName())}
              </div>
              <input
                ref={nameInputRef}
                id="agent-name"
                type="text"
                className="spawn-modal-input"
                placeholder={suggestedName()}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setLocalError(null);
                }}
                disabled={isSpawning}
              />
            </div>
            <div className="spawn-modal-name-suggestions">
              {NAME_PREFIXES.slice(0, 4).map((prefix) => (
                <button
                  key={prefix}
                  type="button"
                  className="spawn-modal-suggestion"
                  onClick={() => setName(`${prefix}-1`)}
                >
                  {prefix}-
                </button>
              ))}
            </div>
          </div>

          {/* Custom Command (if custom template) */}
          {selectedTemplate.id === 'custom' && (
            <div className="spawn-modal-section">
              <label className="spawn-modal-label" htmlFor="agent-command">
                Command
              </label>
              <input
                id="agent-command"
                type="text"
                className="spawn-modal-input"
                placeholder="e.g., python agent.py"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                disabled={isSpawning}
              />
            </div>
          )}

          {/* Working Directory (optional) */}
          <div className="spawn-modal-section">
            <label className="spawn-modal-label" htmlFor="agent-cwd">
              Working Directory <span className="spawn-modal-optional">(optional)</span>
            </label>
            <input
              id="agent-cwd"
              type="text"
              className="spawn-modal-input"
              placeholder="Current directory"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              disabled={isSpawning}
            />
          </div>

          {/* Team Assignment (optional) */}
          <div className="spawn-modal-section">
            <label className="spawn-modal-label" htmlFor="agent-team">
              Team <span className="spawn-modal-optional">(optional)</span>
            </label>
            <input
              id="agent-team"
              type="text"
              className="spawn-modal-input"
              placeholder="e.g., frontend, backend, infra"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              disabled={isSpawning}
            />
          </div>

          {/* Error Display */}
          {displayError && (
            <div className="spawn-modal-error">
              <ErrorIcon />
              <span>{displayError}</span>
            </div>
          )}

          {/* Actions */}
          <div className="spawn-modal-actions">
            <button
              type="button"
              className="spawn-modal-btn spawn-modal-btn-secondary"
              onClick={onClose}
              disabled={isSpawning}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="spawn-modal-btn spawn-modal-btn-primary"
              disabled={isSpawning}
            >
              {isSpawning ? (
                <>
                  <Spinner />
                  Spawning...
                </>
              ) : (
                <>
                  <RocketIcon />
                  Spawn Agent
                </>
              )}
            </button>
          </div>
        </form>
      </div>
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

function ErrorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function RocketIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="spawn-modal-spinner" width="16" height="16" viewBox="0 0 24 24">
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

/**
 * CSS styles for the spawn modal
 */
export const spawnModalStyles = `
.spawn-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.15s ease;
}

.spawn-modal {
  background: #ffffff;
  border-radius: 12px;
  width: 480px;
  max-width: 90vw;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 16px 70px rgba(0, 0, 0, 0.2);
  animation: slideUp 0.2s ease;
}

.spawn-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid #e8e8e8;
}

.spawn-modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.spawn-modal-close {
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

.spawn-modal-close:hover {
  background: #f5f5f5;
  color: #333;
}

.spawn-modal form {
  padding: 24px;
}

.spawn-modal-section {
  margin-bottom: 20px;
}

.spawn-modal-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin-bottom: 8px;
}

.spawn-modal-optional {
  font-weight: 400;
  color: #888;
}

.spawn-modal-templates {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.spawn-modal-template {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  background: #f9f9f9;
  border: 2px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}

.spawn-modal-template:hover {
  background: #f0f0f0;
}

.spawn-modal-template.selected {
  background: #e8f4fd;
  border-color: #1264a3;
}

.spawn-modal-template-icon {
  font-size: 24px;
}

.spawn-modal-template-name {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}

.spawn-modal-template-desc {
  font-size: 11px;
  color: #888;
  text-align: center;
}

.spawn-modal-name-input {
  display: flex;
  align-items: center;
  gap: 12px;
}

.spawn-modal-name-preview {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
}

.spawn-modal-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
}

.spawn-modal-input:focus {
  border-color: #1264a3;
}

.spawn-modal-input:disabled {
  background: #f9f9f9;
  color: #888;
}

.spawn-modal-name-suggestions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.spawn-modal-suggestion {
  padding: 4px 8px;
  background: #f5f5f5;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.spawn-modal-suggestion:hover {
  background: #e8e8e8;
  color: #333;
}

.spawn-modal-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  color: #dc2626;
  font-size: 13px;
  margin-bottom: 20px;
}

.spawn-modal-error svg {
  flex-shrink: 0;
}

.spawn-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid #e8e8e8;
}

.spawn-modal-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.spawn-modal-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spawn-modal-btn-secondary {
  background: #f5f5f5;
  color: #666;
}

.spawn-modal-btn-secondary:hover:not(:disabled) {
  background: #e8e8e8;
  color: #333;
}

.spawn-modal-btn-primary {
  background: #1264a3;
  color: #ffffff;
}

.spawn-modal-btn-primary:hover:not(:disabled) {
  background: #0d4f82;
}

.spawn-modal-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
