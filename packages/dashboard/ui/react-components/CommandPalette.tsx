/**
 * CommandPalette Component
 *
 * A Slack/VS Code-style command palette with fuzzy search,
 * keyboard navigation, and categorized commands.
 * Includes inline task assignment flow that creates beads.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Agent, Project } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface Command {
  id: string;
  label: string;
  description?: string;
  category: 'agents' | 'actions' | 'navigation' | 'settings' | 'projects' | 'channels';
  icon?: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface TaskCreateRequest {
  agentName: string;
  title: string;
  priority: TaskPriority;
}

const CATEGORY_ORDER = ['projects', 'agents', 'actions', 'channels', 'navigation', 'settings'] as const;

export const PRIORITY_CONFIG: Record<TaskPriority, { label: string; beadsPriority: number; color: string }> = {
  critical: { label: 'Critical', beadsPriority: 0, color: '#ef4444' },
  high: { label: 'High', beadsPriority: 1, color: '#f97316' },
  medium: { label: 'Medium', beadsPriority: 2, color: '#f59e0b' },
  low: { label: 'Low', beadsPriority: 3, color: '#6366f1' },
};

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  projects?: Project[];
  currentProject?: string;
  onAgentSelect: (agent: Agent) => void;
  onProjectSelect?: (project: Project) => void;
  onSpawnClick: () => void;
  onTaskAssignClick?: () => void;
  onTaskCreate?: (task: TaskCreateRequest) => Promise<void>;
  onSettingsClick?: () => void;
  onGeneralClick?: () => void;
  customCommands?: Command[];
}

export function CommandPalette(props: CommandPaletteProps) {
  if (!props.isOpen) return null;
  return <CommandPaletteContent {...props} />;
}

type PaletteMode = 'search' | 'task-select-agent' | 'task-details';

function CommandPaletteContent({
  onClose,
  agents,
  projects = [],
  currentProject,
  onAgentSelect,
  onProjectSelect,
  onSpawnClick,
  onTaskCreate,
  onSettingsClick,
  onGeneralClick,
  customCommands = [],
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeCategory, setActiveCategory] = useState<typeof CATEGORY_ORDER[number] | null>(null);
  const selectedIndexRef = useRef(selectedIndex);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Task assignment mode state
  const [mode, setMode] = useState<PaletteMode>('search');
  const [taskAgent, setTaskAgent] = useState<Agent | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskPriority, setTaskPriority] = useState<TaskPriority>('medium');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Available agents for task assignment (exclude offline)
  const availableAgents = useMemo(() => {
    return agents.filter((a) => a.status !== 'offline' && a.status !== 'error');
  }, [agents]);

  // Filter agents based on query in task-select-agent mode
  const filteredAgents = useMemo(() => {
    if (!query.trim()) return availableAgents;
    const lowerQuery = query.toLowerCase();
    return availableAgents.filter((a) => a.name.toLowerCase().includes(lowerQuery));
  }, [availableAgents, query]);

  // Reset task state when entering task mode
  const enterTaskMode = useCallback(() => {
    setMode('task-select-agent');
    setQuery('');
    setSelectedIndex(0);
    setTaskAgent(null);
    setTaskTitle('');
    setTaskPriority('medium');
  }, []);

  // Handle task submission
  const handleTaskSubmit = useCallback(async () => {
    if (!taskAgent || !taskTitle.trim() || !onTaskCreate) return;

    setIsSubmitting(true);
    try {
      await onTaskCreate({
        agentName: taskAgent.name,
        title: taskTitle.trim(),
        priority: taskPriority,
      });
      onClose();
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [taskAgent, taskTitle, taskPriority, onTaskCreate, onClose]);

  // Keep ref in sync with state
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // Build command list
  const commands = useMemo(() => {
    // Sort projects: current project first, then alphabetically
    const sortedProjects = [...projects].sort((a, b) => {
      const aIsCurrent = a.id === currentProject;
      const bIsCurrent = b.id === currentProject;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      const aName = a.name || a.path.split('/').pop() || a.id;
      const bName = b.name || b.path.split('/').pop() || b.id;
      return aName.localeCompare(bName);
    });

    const cmds: Command[] = [
      ...sortedProjects.map((project) => {
        const displayName = project.name || project.path.split('/').pop() || project.id;
        const isCurrent = project.id === currentProject;
        return {
          id: `project-${project.id}`,
          label: displayName,
          description: isCurrent
            ? `Current project • ${project.agents.length} agents`
            : `${project.agents.length} agents`,
          category: 'projects' as const,
          icon: isCurrent ? <CurrentProjectIcon /> : <FolderIcon />,
          action: () => {
            onProjectSelect?.(project);
            onClose();
          },
        };
      }),
      ...agents.map((agent) => ({
        id: `agent-${agent.name}`,
        label: agent.name,
        description: agent.currentTask || agent.status,
        category: 'agents' as const,
        icon: <AgentIcon name={agent.name} />,
        action: () => {
          onAgentSelect(agent);
          onClose();
        },
      })),
      {
        id: 'spawn-agent',
        label: 'Spawn Agent',
        description: 'Launch a new agent instance',
        category: 'actions',
        icon: <PlusIcon />,
        shortcut: '⌘⇧S',
        action: () => {
          onSpawnClick();
          onClose();
        },
      },
      {
        id: 'broadcast',
        label: 'Broadcast Message',
        description: 'Send message to all agents',
        category: 'actions',
        icon: <BroadcastIcon />,
        action: () => {
          onClose();
        },
      },
      ...(onTaskCreate
        ? [
            {
              id: 'assign-task',
              label: 'Assign Task',
              description: 'Create a task for an agent (creates bead)',
              category: 'actions' as const,
              icon: <TaskIcon />,
              shortcut: '⌘⇧T',
              action: () => {
                enterTaskMode();
              },
            },
          ]
        : []),
      {
        id: 'nav-general',
        label: 'Go to #general',
        description: 'View all broadcast messages',
        category: 'navigation',
        icon: <HashIcon />,
        action: () => {
          onGeneralClick?.();
          onClose();
        },
      },
      ...(onSettingsClick
        ? [
            {
              id: 'settings',
              label: 'Settings',
              description: 'Configure dashboard preferences',
              category: 'settings' as const,
              icon: <SettingsIcon />,
              shortcut: '⌘,',
              action: () => {
                onSettingsClick();
                onClose();
              },
            },
          ]
        : []),
      ...customCommands,
    ];
    return cmds;
  }, [agents, projects, currentProject, onAgentSelect, onProjectSelect, onSpawnClick, onSettingsClick, onGeneralClick, onClose, customCommands]);

  const filteredCommands = useMemo(() => {
    let filtered = commands;

    // Filter by active category if set
    if (activeCategory) {
      filtered = filtered.filter((cmd) => cmd.category === activeCategory);
    }

    // Filter by search query
    if (query.trim()) {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter(
        (cmd) =>
          cmd.label.toLowerCase().includes(lowerQuery) ||
          cmd.description?.toLowerCase().includes(lowerQuery) ||
          cmd.category.toLowerCase().includes(lowerQuery)
      );
    }

    return filtered;
  }, [commands, query, activeCategory]);

  const groupedCommands = useMemo(() => {
    const groups: Record<string, Command[]> = {};
    for (const cmd of filteredCommands) {
      if (!groups[cmd.category]) {
        groups[cmd.category] = [];
      }
      groups[cmd.category].push(cmd);
    }
    return groups;
  }, [filteredCommands]);

  const flatCommands = useMemo(() => {
    return CATEGORY_ORDER.flatMap((cat) => groupedCommands[cat] || []);
  }, [groupedCommands]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Reset state when component mounts (palette opens)
  useEffect(() => {
    setQuery('');
    setSelectedIndex(0);
    setActiveCategory(null); // Show all categories by default
    setMode('search');
    setTaskAgent(null);
    setTaskTitle('');
    setTaskPriority('medium');
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Handle task-details mode separately
      if (mode === 'task-details') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setMode('task-select-agent');
          setQuery('');
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          handleTaskSubmit();
        }
        return;
      }

      // Handle task-select-agent mode
      if (mode === 'task-select-agent') {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, filteredAgents.length - 1));
            break;
          case 'ArrowUp':
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
            break;
          case 'Enter':
            e.preventDefault();
            if (filteredAgents[selectedIndexRef.current]) {
              setTaskAgent(filteredAgents[selectedIndexRef.current]);
              setMode('task-details');
              setQuery('');
            }
            break;
          case 'Escape':
            e.preventDefault();
            setMode('search');
            setQuery('');
            break;
        }
        return;
      }

      // Default search mode
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, flatCommands.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatCommands[selectedIndexRef.current]) {
            flatCommands[selectedIndexRef.current].action();
          }
          break;
        case 'Tab':
          e.preventDefault();
          // Cycle through categories: null -> projects -> agents -> actions -> ... -> null
          setActiveCategory(prev => {
            if (prev === null) return CATEGORY_ORDER[0];
            const currentIdx = CATEGORY_ORDER.indexOf(prev);
            if (e.shiftKey) {
              // Shift+Tab: go backwards
              return currentIdx === 0 ? null : CATEGORY_ORDER[currentIdx - 1];
            } else {
              // Tab: go forwards
              return currentIdx === CATEGORY_ORDER.length - 1 ? null : CATEGORY_ORDER[currentIdx + 1];
            }
          });
          setSelectedIndex(0);
          break;
        case 'Escape':
          e.preventDefault();
          // If filtering by category, clear filter first
          if (activeCategory) {
            setActiveCategory(null);
            setSelectedIndex(0);
          } else {
            onClose();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [flatCommands, filteredAgents, mode, selectedIndex, activeCategory, onClose, handleTaskSubmit]);

  const categoryLabels: Record<string, string> = {
    projects: 'Projects',
    agents: 'Agents',
    actions: 'Actions',
    navigation: 'Navigation',
    settings: 'Settings',
  };

  let globalIndex = 0;

  // Render task-select-agent mode
  if (mode === 'task-select-agent') {
    return (
      <div
        className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-[1000] animate-fade-in"
        onClick={() => { setMode('search'); setQuery(''); }}
      >
        <div
          className="bg-sidebar-bg border border-sidebar-border rounded-xl w-[560px] max-w-[90vw] max-h-[60vh] flex flex-col shadow-modal animate-slide-down"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 p-4 border-b border-sidebar-border">
            <button
              className="p-1 rounded hover:bg-sidebar-border text-text-muted"
              onClick={() => { setMode('search'); setQuery(''); }}
            >
              <BackIcon />
            </button>
            <TaskIcon />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              className="flex-1 border-none text-base font-sans outline-none bg-transparent text-text-primary placeholder:text-text-muted"
              placeholder="Select agent to assign task..."
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            />
            <kbd className="bg-sidebar-border border border-sidebar-hover rounded px-1.5 py-0.5 text-xs text-text-muted font-sans">
              ESC
            </kbd>
          </div>

          <div className="flex-1 overflow-y-auto p-2" ref={listRef}>
            {filteredAgents.length === 0 ? (
              <div className="py-8 text-center text-text-muted text-sm">
                {query ? `No agents matching "${query}"` : 'No available agents'}
              </div>
            ) : (
              <>
                <div className="text-xs font-semibold text-text-muted uppercase tracking-wider py-2 px-3">
                  Select Agent
                </div>
                {filteredAgents.map((agent, idx) => {
                  const colors = getAgentColor(agent.name);
                  return (
                    <button
                      key={agent.name}
                      ref={el => { itemRefs.current[idx] = el; }}
                      className={`
                        flex items-center gap-3 w-full py-2.5 px-3 border-none rounded-lg cursor-pointer text-left font-sans transition-colors duration-100
                        ${idx === selectedIndex ? 'bg-accent-light border border-accent/30' : 'bg-transparent hover:bg-sidebar-border'}
                      `}
                      onClick={() => {
                        setTaskAgent(agent);
                        setMode('task-details');
                        setQuery('');
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      <div
                        className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold"
                        style={{ backgroundColor: colors.primary, color: colors.text }}
                      >
                        {getAgentInitials(agent.name)}
                      </div>
                      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-text-primary">{agent.name}</span>
                        <span className="text-xs text-text-muted truncate">
                          {agent.currentTask || agent.status}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Render task-details mode
  if (mode === 'task-details' && taskAgent) {
    const agentColors = getAgentColor(taskAgent.name);
    return (
      <div
        className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-[1000] animate-fade-in"
        onClick={() => { setMode('task-select-agent'); setQuery(''); }}
      >
        <div
          className="bg-sidebar-bg border border-sidebar-border rounded-xl w-[560px] max-w-[90vw] flex flex-col shadow-modal animate-slide-down"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 p-4 border-b border-sidebar-border">
            <button
              className="p-1 rounded hover:bg-sidebar-border text-text-muted"
              onClick={() => { setMode('task-select-agent'); setQuery(''); }}
            >
              <BackIcon />
            </button>
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold"
              style={{ backgroundColor: agentColors.primary, color: agentColors.text }}
            >
              {getAgentInitials(taskAgent.name)}
            </div>
            <span className="text-base font-medium text-text-primary">
              Assign task to {taskAgent.name}
            </span>
          </div>

          <div className="p-4 flex flex-col gap-4">
            {/* Task Title */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5">
                Task Title
              </label>
              <input
                autoFocus
                type="text"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="What needs to be done?"
                className="w-full px-3 py-2 text-sm bg-bg-tertiary border border-sidebar-border rounded-md text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent-cyan"
              />
            </div>

            {/* Priority */}
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5">
                Priority
              </label>
              <div className="flex gap-2">
                {(Object.keys(PRIORITY_CONFIG) as TaskPriority[]).map((p) => {
                  const config = PRIORITY_CONFIG[p];
                  const isSelected = taskPriority === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-all ${
                        isSelected
                          ? 'border-transparent text-white'
                          : 'border-sidebar-border text-text-muted hover:border-sidebar-hover'
                      }`}
                      style={{
                        backgroundColor: isSelected ? config.color : 'transparent',
                      }}
                      onClick={() => setTaskPriority(p)}
                    >
                      {config.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-text-dim mt-1.5">
                Maps to beads priority P{PRIORITY_CONFIG[taskPriority].beadsPriority}
              </p>
            </div>

            {/* Submit */}
            <div className="flex justify-end gap-2 pt-2 border-t border-sidebar-border">
              <button
                type="button"
                className="px-4 py-2 text-sm text-text-muted hover:text-text-primary transition-colors"
                onClick={() => { setMode('task-select-agent'); setQuery(''); }}
              >
                Back
              </button>
              <button
                type="button"
                disabled={!taskTitle.trim() || isSubmitting}
                onClick={handleTaskSubmit}
                className="px-4 py-2 text-sm font-medium bg-accent-cyan text-bg-deep rounded-md hover:bg-accent-cyan/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <SpinnerIcon />
                    Creating...
                  </>
                ) : (
                  <>
                    Create Task
                    <kbd className="bg-black/20 rounded px-1 py-0.5 text-[10px]">⌘↵</kbd>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Default search mode
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-[1000] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-sidebar-bg border border-sidebar-border rounded-xl w-[560px] max-w-[90vw] max-h-[60vh] flex flex-col shadow-modal animate-slide-down"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 p-4 border-b border-sidebar-border">
          <SearchIcon />
          {activeCategory && (
            <button
              onClick={() => { setActiveCategory(null); setSelectedIndex(0); }}
              className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-accent-cyan/20 text-accent-cyan rounded-md hover:bg-accent-cyan/30 transition-colors"
            >
              {categoryLabels[activeCategory]}
              <span className="text-accent-cyan/60">×</span>
            </button>
          )}
          <input
            ref={inputRef}
            autoFocus
            type="text"
            className="flex-1 border-none text-base font-sans outline-none bg-transparent text-text-primary placeholder:text-text-muted"
            placeholder={activeCategory ? `Search ${categoryLabels[activeCategory].toLowerCase()}...` : "Search commands, agents..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="bg-sidebar-border border border-sidebar-hover rounded px-1.5 py-0.5 text-xs text-text-muted font-sans" title="Cycle categories">
            Tab
          </kbd>
          <kbd className="bg-sidebar-border border border-sidebar-hover rounded px-1.5 py-0.5 text-xs text-text-muted font-sans">
            ESC
          </kbd>
        </div>

        <div className="flex-1 overflow-y-auto p-2" ref={listRef}>
          {flatCommands.length === 0 ? (
            <div className="py-8 text-center text-text-muted text-sm">
              No results for "{query}"
            </div>
          ) : (
            CATEGORY_ORDER.map((category) => {
              const cmds = groupedCommands[category];
              if (!cmds?.length) return null;
              return (
                <div key={category} className="mb-2">
                  <div className="text-xs font-semibold text-text-muted uppercase tracking-wider py-2 px-3">
                    {categoryLabels[category] || category}
                  </div>
                  {cmds.map((cmd) => {
                    const idx = globalIndex++;
                    return (
                      <button
                        key={cmd.id}
                        ref={el => { itemRefs.current[idx] = el; }}
                        className={`
                          flex items-center gap-3 w-full py-2.5 px-3 border-none rounded-lg cursor-pointer text-left font-sans transition-colors duration-100
                          ${idx === selectedIndex ? 'bg-accent-light border border-accent/30' : 'bg-transparent hover:bg-sidebar-border'}
                        `}
                        onClick={cmd.action}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <span className="flex items-center justify-center w-7 h-7 text-text-muted">{cmd.icon}</span>
                        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-text-primary">{cmd.label}</span>
                          {cmd.description && (
                            <span className="text-xs text-text-muted truncate">{cmd.description}</span>
                          )}
                        </span>
                        {cmd.shortcut && (
                          <kbd className="bg-sidebar-border border border-sidebar-hover rounded px-1.5 py-0.5 text-xs text-text-muted font-sans">
                            {cmd.shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function AgentIcon({ name }: { name: string }) {
  const colors = getAgentColor(name);
  return (
    <div
      className="w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold"
      style={{ backgroundColor: colors.primary, color: colors.text }}
    >
      {getAgentInitials(name)}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg className="text-text-muted shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
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

function BroadcastIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </svg>
  );
}

function HashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
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

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CurrentProjectIcon() {
  return (
    <div className="relative">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-cyan">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <svg
        className="absolute -bottom-0.5 -right-0.5 text-accent-cyan bg-sidebar-bg rounded-full"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
      </svg>
    </div>
  );
}

function TaskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24">
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
