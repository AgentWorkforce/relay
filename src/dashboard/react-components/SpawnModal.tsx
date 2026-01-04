/**
 * SpawnModal Component
 *
 * Modal for spawning new agent instances with configuration options.
 * Supports different agent types (claude, codex, etc.) and naming conventions.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export type SpeakOnTrigger = 'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES';

export interface SpawnConfig {
  name: string;
  command: string;
  cwd?: string;
  team?: string;
  shadowMode?: 'subagent' | 'process';
  shadowOf?: string;
  shadowAgent?: string;
  shadowTriggers?: SpeakOnTrigger[];
  shadowSpeakOn?: SpeakOnTrigger[];
}

function deriveShadowMode(command: string): 'subagent' | 'process' {
  const base = command.trim().split(' ')[0].toLowerCase();
  if (base.startsWith('claude') || base === 'codex' || base === 'opencode' || base === 'gemini' || base === 'droid') return 'subagent';
  return 'process';
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
    id: 'gemini',
    name: 'Gemini',
    command: 'gemini',
    description: 'Google Gemini CLI agent',
    icon: '💎',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    description: 'OpenCode AI agent',
    icon: '🔷',
  },
  {
    id: 'droid',
    name: 'Droid',
    command: 'droid',
    description: 'Factory Droid agent',
    icon: '🤖',
  },
  {
    id: 'custom',
    name: 'Custom',
    command: '',
    description: 'Custom command',
    icon: '🔧',
  },
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
  const [isShadow, setIsShadow] = useState(false);
  const [shadowOf, setShadowOf] = useState('');
  const [shadowAgent, setShadowAgent] = useState('');
  const [shadowSpeakOn, setShadowSpeakOn] = useState<SpeakOnTrigger[]>(['EXPLICIT_ASK']);
  const [localError, setLocalError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const effectiveCommand = selectedTemplate.id === 'custom' ? customCommand : selectedTemplate.command;
  const shadowMode = useMemo(() => deriveShadowMode(effectiveCommand), [effectiveCommand]);

  const SPEAK_ON_OPTIONS: { value: SpeakOnTrigger; label: string; description: string }[] = [
    { value: 'EXPLICIT_ASK', label: 'Explicit Ask', description: 'When directly asked' },
    { value: 'SESSION_END', label: 'Session End', description: 'When session ends' },
    { value: 'CODE_WRITTEN', label: 'Code Written', description: 'When code is written' },
    { value: 'REVIEW_REQUEST', label: 'Review Request', description: 'When review requested' },
    { value: 'ALL_MESSAGES', label: 'All Messages', description: 'On every message' },
  ];

  const suggestedName = useCallback(() => {
    const prefix = selectedTemplate.id === 'claude' ? 'claude' : selectedTemplate.id;
    let num = 1;
    while (existingAgents.includes(`${prefix}-${num}`)) {
      num++;
    }
    return `${prefix}-${num}`;
  }, [selectedTemplate, existingAgents]);

  useEffect(() => {
    if (isOpen) {
      setSelectedTemplate(AGENT_TEMPLATES[0]);
      setName('');
      setCustomCommand('');
      setCwd('');
      setTeam('');
      setIsShadow(false);
      setShadowOf('');
      setShadowAgent('');
      setShadowSpeakOn(['EXPLICIT_ASK']);
      setLocalError(null);
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [isOpen]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const finalName = name.trim() || suggestedName();
    const nameError = validateName(finalName);
    if (nameError) {
      setLocalError(nameError);
      return;
    }

    const command = effectiveCommand;
    if (!command.trim()) {
      setLocalError('Command is required');
      return;
    }

    if (isShadow && !shadowOf) {
      setLocalError('Please select an agent to shadow');
      return;
    }

    setLocalError(null);
    const success = await onSpawn({
      name: finalName,
      command: command.trim(),
      cwd: cwd.trim() || undefined,
      team: team.trim() || undefined,
      shadowMode: shadowMode,
      shadowOf: isShadow ? shadowOf : undefined,
      shadowAgent: shadowAgent.trim() || undefined,
      shadowTriggers: isShadow ? shadowSpeakOn : undefined,
      shadowSpeakOn: isShadow ? shadowSpeakOn : undefined,
    });

    if (success) {
      onClose();
    }
  };

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
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-bg-primary border border-border rounded-xl w-[480px] max-w-[90vw] max-h-[90vh] overflow-y-auto shadow-modal animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="m-0 text-lg font-semibold text-text-primary">Spawn New Agent</h2>
          <button
            className="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-md text-text-muted cursor-pointer transition-all duration-150 hover:bg-bg-hover hover:text-text-primary"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          {/* Agent Type Selection */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-text-primary mb-2">Agent Type</label>
            <div className="grid grid-cols-3 gap-2">
              {AGENT_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={`
                    flex flex-col items-center gap-1 py-3 px-2 border-2 rounded-lg cursor-pointer font-sans transition-all duration-150
                    ${selectedTemplate.id === template.id
                      ? 'bg-accent/10 border-accent'
                      : 'bg-bg-hover border-transparent hover:bg-bg-active'
                    }
                  `}
                  onClick={() => setSelectedTemplate(template)}
                >
                  <span className="text-2xl">{template.icon}</span>
                  <span className="text-sm font-semibold text-text-primary">{template.name}</span>
                  <span className="text-xs text-text-muted text-center">{template.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Agent Name */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-text-primary mb-2" htmlFor="agent-name">
              Agent Name
            </label>
            <div className="flex items-center gap-3">
              <div
                className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-sm font-semibold"
                style={{ backgroundColor: colors.primary, color: colors.text }}
              >
                {getAgentInitials(name || suggestedName())}
              </div>
              <input
                ref={nameInputRef}
                id="agent-name"
                type="text"
                className="flex-1 py-2.5 px-3.5 border border-border rounded-md text-sm font-sans outline-none bg-transparent text-text-primary transition-colors duration-150 focus:border-accent disabled:bg-bg-hover disabled:text-text-muted placeholder:text-text-muted"
                placeholder={suggestedName()}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setLocalError(null);
                }}
                disabled={isSpawning}
              />
            </div>
          </div>

          {/* Team Assignment - moved higher for prominence */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-text-primary mb-2" htmlFor="agent-team">
              Team <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <input
              id="agent-team"
              type="text"
              className="w-full py-2.5 px-3.5 border border-border rounded-md text-sm font-sans outline-none bg-transparent text-text-primary transition-colors duration-150 focus:border-accent disabled:bg-bg-hover disabled:text-text-muted placeholder:text-text-muted"
              placeholder="e.g., frontend, backend, infra"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              disabled={isSpawning}
            />
          </div>

          {/* Custom Command (if custom template) */}
          {selectedTemplate.id === 'custom' && (
            <div className="mb-5">
              <label className="block text-sm font-semibold text-text-primary mb-2" htmlFor="agent-command">
                Command
              </label>
              <input
                id="agent-command"
                type="text"
                className="w-full py-2.5 px-3.5 border border-border rounded-md text-sm font-sans outline-none bg-transparent text-text-primary transition-colors duration-150 focus:border-accent disabled:bg-bg-hover disabled:text-text-muted placeholder:text-text-muted"
                placeholder="e.g., python agent.py"
                value={customCommand}
                onChange={(e) => setCustomCommand(e.target.value)}
                disabled={isSpawning}
              />
            </div>
          )}

          {/* Working Directory (optional) */}
          <div className="mb-5">
            <label className="block text-sm font-semibold text-text-primary mb-2" htmlFor="agent-cwd">
              Working Directory <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <input
              id="agent-cwd"
              type="text"
              className="w-full py-2.5 px-3.5 border border-border rounded-md text-sm font-sans outline-none bg-transparent text-text-primary transition-colors duration-150 focus:border-accent disabled:bg-bg-hover disabled:text-text-muted placeholder:text-text-muted"
              placeholder="Current directory"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              disabled={isSpawning}
            />
          </div>

          {/* Shadow Agent Configuration */}
          <div className="mb-5 p-4 border border-border rounded-lg bg-bg-hover/50">
            <div className="flex items-center justify-between mb-3">
              <div>
                <label className="block text-sm font-semibold text-text-primary">
                  Shadow Mode
                </label>
                <span className="text-xs text-text-muted">
                  Shadow execution: {shadowMode === 'subagent' ? 'Subagent (in-process)' : 'Process (separate)'}
                </span>
              </div>
              <button
                type="button"
                className={`
                  relative w-11 h-6 rounded-full transition-colors duration-200
                  ${isShadow ? 'bg-accent' : 'bg-bg-active'}
                `}
                onClick={() => setIsShadow(!isShadow)}
                disabled={isSpawning}
                aria-pressed={isShadow}
              >
                <span
                  className={`
                    absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform duration-200 shadow-sm
                    ${isShadow ? 'translate-x-5' : 'translate-x-0'}
                  `}
                />
              </button>
            </div>

            {isShadow && (
              <>
                {/* Primary Agent Selection */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-text-secondary mb-2" htmlFor="shadow-of">
                    Shadow Agent
                  </label>
                  <select
                    id="shadow-of"
                    className="w-full py-2.5 px-3.5 border border-border rounded-md text-sm font-sans outline-none bg-bg-primary text-text-primary transition-colors duration-150 focus:border-accent disabled:bg-bg-hover disabled:text-text-muted"
                    value={shadowOf}
                    onChange={(e) => setShadowOf(e.target.value)}
                    disabled={isSpawning}
                  >
                    <option value="">Select an agent to shadow...</option>
                    {existingAgents.map((agent) => (
                      <option key={agent} value={agent}>
                        {agent}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Shadow Agent Profile (optional) */}
                <div className="mb-4">
                  <label className="block text-sm font-medium text-text-secondary mb-2" htmlFor="shadow-agent">
                    Shadow Agent Profile <span className="font-normal text-text-muted">(optional)</span>
                  </label>
                  <input
                    id="shadow-agent"
                    type="text"
                    className="w-full py-2.5 px-3.5 border border-border rounded-md text-sm font-sans outline-none bg-bg-primary text-text-primary transition-colors duration-150 focus:border-accent disabled:bg-bg-hover disabled:text-text-muted placeholder:text-text-muted"
                    placeholder="e.g., shadow-reviewer"
                    value={shadowAgent}
                    onChange={(e) => setShadowAgent(e.target.value)}
                    disabled={isSpawning}
                  />
                </div>

                {/* Speak On Triggers */}
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-2">
                    Speak When
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {SPEAK_ON_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`
                          py-1.5 px-3 rounded-md text-xs font-medium transition-all duration-150 border
                          ${shadowSpeakOn.includes(option.value)
                            ? 'bg-accent/20 border-accent text-accent'
                            : 'bg-bg-primary border-border text-text-secondary hover:bg-bg-active hover:text-text-primary'
                          }
                        `}
                        onClick={() => {
                          if (shadowSpeakOn.includes(option.value)) {
                            setShadowSpeakOn(shadowSpeakOn.filter(t => t !== option.value));
                          } else {
                            setShadowSpeakOn([...shadowSpeakOn, option.value]);
                          }
                        }}
                        disabled={isSpawning}
                        title={option.description}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Error Display */}
          {displayError && (
            <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/30 rounded-md text-error text-sm mb-5">
              <ErrorIcon />
              <span>{displayError}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              className="flex items-center gap-1.5 py-2.5 px-4 border-none rounded-md text-sm font-medium cursor-pointer font-sans transition-all duration-150 bg-bg-hover text-text-secondary hover:bg-bg-active hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={onClose}
              disabled={isSpawning}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 py-2.5 px-4 border-none rounded-md text-sm font-medium cursor-pointer font-sans transition-all duration-150 bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
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
    <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
    <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24">
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
