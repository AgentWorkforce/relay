/**
 * Agent Registry
 * Persists agent metadata across daemon restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../utils/logger.js';

const log = createLogger('registry');

/**
 * Agent profile information for display and understanding agent behavior
 */
export interface AgentProfileRecord {
  /** Display title/role (e.g., "Lead Developer", "Code Reviewer") */
  title?: string;
  /** Short description of what this agent does */
  description?: string;
  /** The prompt/task the agent was spawned with */
  spawnPrompt?: string;
  /** Agent profile/persona prompt (e.g., lead agent instructions) */
  personaPrompt?: string;
  /** Name of the persona preset used (e.g., "lead", "reviewer", "shadow-auditor") */
  personaName?: string;
  /** Capabilities or tools available to the agent */
  capabilities?: string[];
  /** Tags for categorization */
  tags?: string[];
}

export interface AgentRecord {
  id: string;
  name: string;
  cli?: string;
  program?: string;
  model?: string;
  task?: string;
  workingDirectory?: string;
  team?: string;
  firstSeen: string;
  lastSeen: string;
  messagesSent: number;
  messagesReceived: number;
  /** Profile information for understanding agent behavior */
  profile?: AgentProfileRecord;
}

type AgentInput = {
  name: string;
  cli?: string;
  program?: string;
  model?: string;
  task?: string;
  workingDirectory?: string;
  team?: string;
  profile?: AgentProfileRecord;
};

export class AgentRegistry {
  private registryPath: string;
  private agents: Map<string, AgentRecord> = new Map(); // name -> record

  constructor(teamDir: string) {
    this.registryPath = path.join(teamDir, 'agents.json');
    this.ensureDir(teamDir);
    this.load();
  }

  /**
   * Register or update an agent (public alias for registerOrUpdate to match docs).
   */
  register(agent: AgentInput): AgentRecord {
    return this.registerOrUpdate(agent);
  }

  /**
   * Register or update an agent, refreshing lastSeen and metadata.
   */
  registerOrUpdate(agent: AgentInput): AgentRecord {
    const now = new Date().toISOString();
    const existing = this.agents.get(agent.name);

    if (existing) {
      // Merge profile data if provided
      const mergedProfile = agent.profile
        ? { ...existing.profile, ...agent.profile }
        : existing.profile;

      const updated: AgentRecord = {
        ...existing,
        cli: agent.cli ?? existing.cli,
        program: agent.program ?? existing.program,
        model: agent.model ?? existing.model,
        task: agent.task ?? existing.task,
        workingDirectory: agent.workingDirectory ?? existing.workingDirectory,
        team: agent.team ?? existing.team,
        profile: mergedProfile,
        lastSeen: now,
      };
      this.agents.set(agent.name, updated);
      this.save();
      return updated;
    }

    const record: AgentRecord = {
      id: `agent-${uuid()}`,
      name: agent.name,
      cli: agent.cli,
      program: agent.program,
      model: agent.model,
      task: agent.task,
      workingDirectory: agent.workingDirectory,
      team: agent.team,
      profile: agent.profile,
      firstSeen: now,
      lastSeen: now,
      messagesSent: 0,
      messagesReceived: 0,
    };

    this.agents.set(agent.name, record);
    this.save();
    return record;
  }

  /**
   * Increment sent counter for an agent.
   */
  recordSend(agentName: string): void {
    const record = this.ensureRecord(agentName);
    record.messagesSent += 1;
    record.lastSeen = new Date().toISOString();
    this.agents.set(agentName, record);
    this.save();
  }

  /**
   * Increment received counter for an agent.
   */
  recordReceive(agentName: string): void {
    const record = this.ensureRecord(agentName);
    record.messagesReceived += 1;
    record.lastSeen = new Date().toISOString();
    this.agents.set(agentName, record);
    this.save();
  }

  /**
   * Touch lastSeen for an agent (e.g., on disconnect).
   */
  touch(agentName: string): void {
    const record = this.ensureRecord(agentName);
    record.lastSeen = new Date().toISOString();
    this.agents.set(agentName, record);
    this.save();
  }

  /**
   * Get a snapshot of all agents.
   */
  getAgents(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  private ensureRecord(agentName: string): AgentRecord {
    const existing = this.agents.get(agentName);
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: AgentRecord = {
      id: `agent-${uuid()}`,
      name: agentName,
      firstSeen: now,
      lastSeen: now,
      messagesSent: 0,
      messagesReceived: 0,
    };

    this.agents.set(agentName, record);
    return record;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load(): void {
    if (!fs.existsSync(this.registryPath)) {
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const rawAgents = Array.isArray(data?.agents)
        ? data.agents
        : typeof data?.agents === 'object' && data?.agents !== null
          ? Object.values(data.agents)
          : [];

      for (const raw of rawAgents) {
        if (!raw?.name) continue;
        const record: AgentRecord = {
          id: raw.id ?? `agent-${uuid()}`,
          name: raw.name,
          cli: raw.cli,
          program: raw.program,
          model: raw.model,
          task: raw.task,
          workingDirectory: raw.workingDirectory,
          team: raw.team,
          profile: raw.profile,
          firstSeen: raw.firstSeen ?? new Date().toISOString(),
          lastSeen: raw.lastSeen ?? new Date().toISOString(),
          messagesSent: typeof raw.messagesSent === 'number' ? raw.messagesSent : 0,
          messagesReceived: typeof raw.messagesReceived === 'number' ? raw.messagesReceived : 0,
        };
        this.agents.set(record.name, record);
      }
    } catch (err) {
      log.error('Failed to load agents.json', { error: String(err) });
    }
  }

  save(): void {
    try {
      const data = JSON.stringify({ agents: this.getAgents() }, null, 2);
      // Write atomically: write to temp file first, then rename
      // This prevents race conditions where readers see partial/empty data
      const tempPath = `${this.registryPath}.tmp`;
      fs.writeFileSync(tempPath, data, 'utf-8');
      fs.renameSync(tempPath, this.registryPath);
    } catch (err) {
      log.error('Failed to write agents.json', { error: String(err) });
    }
  }
}
