/**
 * Agent State Manager
 * Persists agent context between spawns for non-hook CLIs (Codex, Gemini, etc.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AgentState {
  name: string;
  lastActive: string;
  currentTask: string;
  completedTasks: string[];
  decisions: string[];  // Key decisions made
  context: string;      // Summary of recent work
  files: string[];      // Files being worked on
}

export class AgentStateManager {
  private dataDir: string;

  constructor(dataDir: string = '/tmp/agent-relay-team') {
    this.dataDir = dataDir;
  }

  private getStatePath(agentName: string): string {
    return path.join(this.dataDir, agentName, 'state.json');
  }

  /**
   * Load agent state from file
   */
  load(agentName: string): AgentState | null {
    const statePath = this.getStatePath(agentName);

    if (!fs.existsSync(statePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(content) as AgentState;
    } catch {
      return null;
    }
  }

  /**
   * Save agent state to file
   */
  save(state: AgentState): void {
    const statePath = this.getStatePath(state.name);
    const dir = path.dirname(statePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Update specific fields in state
   */
  update(agentName: string, updates: Partial<AgentState>): AgentState {
    const existing = this.load(agentName) || {
      name: agentName,
      lastActive: new Date().toISOString(),
      currentTask: '',
      completedTasks: [],
      decisions: [],
      context: '',
      files: [],
    };

    const updated: AgentState = {
      ...existing,
      ...updates,
      lastActive: new Date().toISOString(),
    };

    this.save(updated);
    return updated;
  }

  /**
   * Format state as context for agent prompt
   */
  formatAsContext(agentName: string): string {
    const state = this.load(agentName);

    if (!state) {
      return 'No previous session state found. Starting fresh.';
    }

    const lines = [
      '=== PREVIOUS SESSION CONTEXT ===',
      `Last active: ${state.lastActive}`,
      '',
    ];

    if (state.currentTask) {
      lines.push(`Current task: ${state.currentTask}`);
    }

    if (state.completedTasks.length > 0) {
      lines.push('');
      lines.push('Completed tasks:');
      state.completedTasks.forEach(t => lines.push(`  - ${t}`));
    }

    if (state.decisions.length > 0) {
      lines.push('');
      lines.push('Key decisions made:');
      state.decisions.forEach(d => lines.push(`  - ${d}`));
    }

    if (state.context) {
      lines.push('');
      lines.push('Context:');
      lines.push(state.context);
    }

    if (state.files.length > 0) {
      lines.push('');
      lines.push('Files being worked on:');
      state.files.forEach(f => lines.push(`  - ${f}`));
    }

    lines.push('=== END CONTEXT ===');
    lines.push('');

    return lines.join('\n');
  }
}

/**
 * CLI helper to save state from agent output
 * Agent outputs: [[STATE]]{"currentTask": "...", "context": "..."}[[/STATE]]
 */
export function parseStateFromOutput(output: string): Partial<AgentState> | null {
  const match = output.match(/\[\[STATE\]\]([\s\S]*?)\[\[\/STATE\]\]/);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]) as Partial<AgentState>;
  } catch {
    return null;
  }
}
