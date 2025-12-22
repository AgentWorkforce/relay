/**
 * Agent Registry
 * Persists agent metadata across daemon restarts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';

export interface AgentRecord {
  id: string;
  name: string;
  cli?: string;
  workingDirectory?: string;
  firstSeen: string;
  lastSeen: string;
  messagesSent: number;
  messagesReceived: number;
}

type AgentInput = {
  name: string;
  cli?: string;
  workingDirectory?: string;
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
   * Register or update an agent, refreshing lastSeen and metadata.
   */
  registerOrUpdate(agent: AgentInput): AgentRecord {
    const now = new Date().toISOString();
    const existing = this.agents.get(agent.name);

    if (existing) {
      const updated: AgentRecord = {
        ...existing,
        cli: agent.cli ?? existing.cli,
        workingDirectory: agent.workingDirectory ?? existing.workingDirectory,
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
      workingDirectory: agent.workingDirectory,
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

  private load(): void {
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
          workingDirectory: raw.workingDirectory,
          firstSeen: raw.firstSeen ?? new Date().toISOString(),
          lastSeen: raw.lastSeen ?? new Date().toISOString(),
          messagesSent: typeof raw.messagesSent === 'number' ? raw.messagesSent : 0,
          messagesReceived: typeof raw.messagesReceived === 'number' ? raw.messagesReceived : 0,
        };
        this.agents.set(record.name, record);
      }
    } catch (err) {
      console.error('[registry] Failed to load agents.json:', err);
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(
        this.registryPath,
        JSON.stringify({ agents: this.getAgents() }, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('[registry] Failed to write agents.json:', err);
    }
  }
}
