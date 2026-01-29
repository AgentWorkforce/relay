/**
 * TaskAssignmentUI Component
 *
 * Allows users to assign tasks to agents with priority and description.
 * Part of Dashboard V2 - Fleet Control.
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { Agent } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface TaskAssignment {
  id: string;
  agentName: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
  createdAt: string;
  assignedAt?: string;
  completedAt?: string;
  result?: string;
}

export interface TaskAssignmentUIProps {
  agents: Agent[];
  tasks?: TaskAssignment[];
  onAssign: (agentName: string, title: string, description: string, priority: TaskAssignment['priority']) => Promise<void>;
  onCancel?: (taskId: string) => Promise<void>;
  isAssigning?: boolean;
}

export function TaskAssignmentUI({
  agents,
  tasks = [],
  onAssign,
  onCancel,
  isAssigning = false,
}: TaskAssignmentUIProps) {
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskAssignment['priority']>('medium');
  const [showForm, setShowForm] = useState(false);

  // Filter to available agents (exclude offline and error states)
  const availableAgents = useMemo(() => {
    return agents.filter((a) => a.status !== 'offline' && a.status !== 'error');
  }, [agents]);

  // Group tasks by status
  const tasksByStatus = useMemo(() => {
    const groups: Record<TaskAssignment['status'], TaskAssignment[]> = {
      pending: [],
      assigned: [],
      in_progress: [],
      completed: [],
      failed: [],
    };
    tasks.forEach((t) => {
      groups[t.status].push(t);
    });
    return groups;
  }, [tasks]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent || !title.trim()) return;

    await onAssign(selectedAgent, title.trim(), description.trim(), priority);

    // Reset form
    setTitle('');
    setDescription('');
    setPriority('medium');
    setShowForm(false);
  }, [selectedAgent, title, description, priority, onAssign]);

  const priorityColors: Record<TaskAssignment['priority'], string> = {
    low: '#6366f1',
    medium: '#f59e0b',
    high: '#f97316',
    critical: '#ef4444',
  };

  return (
    <div className="bg-bg-card rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-tertiary">
        <div className="flex items-center gap-2">
          <TaskIcon />
          <span className="font-medium text-sm text-text-primary">Task Assignment</span>
          <span className="text-xs text-text-muted bg-bg-elevated px-2 py-0.5 rounded-full">
            {tasks.length} tasks
          </span>
        </div>
        <button
          className="px-3 py-1.5 text-xs font-medium bg-accent text-bg-deep rounded-md hover:bg-accent/90 transition-colors"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Cancel' : '+ New Task'}
        </button>
      </div>

      {/* New Task Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="p-4 border-b border-border bg-bg-tertiary/50">
          <div className="flex flex-col gap-4">
            {/* Agent Selection */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Assign to Agent
              </label>
              <div className="grid grid-cols-4 gap-2">
                {availableAgents.map((agent) => {
                  const colors = getAgentColor(agent.name);
                  const isSelected = selectedAgent === agent.name;
                  return (
                    <button
                      key={agent.name}
                      type="button"
                      className={`flex items-center gap-2 p-2 rounded-md border transition-all ${
                        isSelected
                          ? 'border-accent bg-accent/10'
                          : 'border-border hover:border-border-medium hover:bg-bg-hover'
                      }`}
                      onClick={() => setSelectedAgent(agent.name)}
                    >
                      <div
                        className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold"
                        style={{ backgroundColor: colors.primary, color: colors.text }}
                      >
                        {getAgentInitials(agent.name)}
                      </div>
                      <span className="text-xs text-text-primary truncate">{agent.name}</span>
                    </button>
                  );
                })}
              </div>
              {availableAgents.length === 0 && (
                <p className="text-xs text-text-muted italic mt-2">No agents available</p>
              )}
            </div>

            {/* Title */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Task Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Brief description of the task..."
                className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border rounded-md text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent"
                required
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Description (optional)
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Detailed instructions, context, or requirements..."
                className="w-full px-3 py-2 text-sm bg-bg-elevated border border-border rounded-md text-text-primary placeholder:text-text-dim focus:outline-none focus:border-accent resize-none"
                rows={3}
              />
            </div>

            {/* Priority */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Priority
              </label>
              <div className="flex gap-2">
                {(['low', 'medium', 'high', 'critical'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-all ${
                      priority === p
                        ? 'border-transparent text-white'
                        : 'border-border text-text-secondary hover:border-border-medium'
                    }`}
                    style={{
                      backgroundColor: priority === p ? priorityColors[p] : 'transparent',
                    }}
                    onClick={() => setPriority(p)}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Submit */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!selectedAgent || !title.trim() || isAssigning}
                className="px-4 py-2 text-sm font-medium bg-accent text-bg-deep rounded-md hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isAssigning ? 'Assigning...' : 'Assign Task'}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Task List */}
      <div className="max-h-[400px] overflow-y-auto">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-text-muted">
            <EmptyIcon />
            <span className="text-sm">No tasks assigned yet</span>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {/* Active Tasks */}
            {[...tasksByStatus.assigned, ...tasksByStatus.in_progress, ...tasksByStatus.pending].map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onCancel={onCancel}
                priorityColors={priorityColors}
              />
            ))}

            {/* Completed/Failed (collapsed) */}
            {(tasksByStatus.completed.length > 0 || tasksByStatus.failed.length > 0) && (
              <details className="group">
                <summary className="px-4 py-2 text-xs text-text-muted cursor-pointer hover:bg-bg-hover list-none flex items-center gap-2">
                  <ChevronIcon />
                  <span>
                    {tasksByStatus.completed.length + tasksByStatus.failed.length} completed/failed tasks
                  </span>
                </summary>
                <div className="divide-y divide-border">
                  {[...tasksByStatus.completed, ...tasksByStatus.failed].map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onCancel={onCancel}
                      priorityColors={priorityColors}
                    />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface TaskRowProps {
  task: TaskAssignment;
  onCancel?: (taskId: string) => Promise<void>;
  priorityColors: Record<TaskAssignment['priority'], string>;
}

function TaskRow({ task, onCancel, priorityColors }: TaskRowProps) {
  const colors = getAgentColor(task.agentName);
  const statusColors: Record<TaskAssignment['status'], string> = {
    pending: '#6b7280',
    assigned: '#3b82f6',
    in_progress: '#f59e0b',
    completed: '#10b981',
    failed: '#ef4444',
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-bg-hover transition-colors">
      {/* Agent Avatar */}
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold flex-shrink-0"
        style={{ backgroundColor: colors.primary, color: colors.text }}
      >
        {getAgentInitials(task.agentName)}
      </div>

      {/* Task Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">{task.title}</span>
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{
              backgroundColor: `${priorityColors[task.priority]}20`,
              color: priorityColors[task.priority],
            }}
          >
            {task.priority}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>{task.agentName}</span>
          <span>•</span>
          <span
            className="font-medium"
            style={{ color: statusColors[task.status] }}
          >
            {task.status.replace('_', ' ')}
          </span>
        </div>
      </div>

      {/* Cancel Button (for pending/assigned tasks) */}
      {onCancel && (task.status === 'pending' || task.status === 'assigned') && (
        <button
          className="p-1.5 text-text-dim hover:text-error hover:bg-error/10 rounded transition-colors"
          onClick={() => onCancel(task.id)}
          title="Cancel task"
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}

// Icons
function TaskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-secondary">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-dim">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <path d="M9 9l6 6m0-6l-6 6" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="transition-transform group-open:rotate-90"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
