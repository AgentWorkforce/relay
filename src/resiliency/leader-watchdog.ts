/**
 * Leader Watchdog
 *
 * Implements P3: Monitor lead health, trigger promotion if lead dies.
 * Integrates with AgentSupervisor and heartbeat system.
 *
 * Features:
 * - Monitors leader heartbeat file
 * - Detects stale/missing leader
 * - Triggers leader election or self-promotion
 * - Integrates with supervisor events
 */

import * as path from 'path';
import { EventEmitter } from 'events';
import { StatelessLeadCoordinator, LeadHeartbeat } from './stateless-lead.js';

/**
 * Watchdog configuration
 */
export interface LeaderWatchdogConfig {
  /** Path to .beads directory */
  beadsDir: string;
  /** This agent's name */
  agentName: string;
  /** This agent's unique ID */
  agentId: string;
  /** How often to check leader health (ms) */
  checkIntervalMs: number;
  /** Leader considered stale after this duration (ms) */
  staleThresholdMs: number;
  /** Callback when this agent should become leader */
  onBecomeLeader: () => Promise<void>;
  /** Callback to get all healthy agents for election */
  getHealthyAgents: () => Promise<Array<{ name: string; id: string; spawnedAt: Date }>>;
}

const DEFAULT_CONFIG: Partial<LeaderWatchdogConfig> = {
  checkIntervalMs: 5000,
  staleThresholdMs: 30000,
};

/**
 * Election result
 */
export interface ElectionResult {
  winner: string;
  winnerId: string;
  candidates: string[];
  method: 'oldest' | 'self' | 'none';
}

/**
 * Leader Watchdog
 *
 * Runs on each agent, monitors leader health, triggers election if needed.
 */
export class LeaderWatchdog extends EventEmitter {
  private config: LeaderWatchdogConfig;
  private heartbeatPath: string;
  private checkInterval?: ReturnType<typeof setInterval>;
  private isRunning = false;
  private currentLeader: LeadHeartbeat | null = null;
  private isLeader = false;

  constructor(config: LeaderWatchdogConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as LeaderWatchdogConfig;
    this.heartbeatPath = path.join(this.config.beadsDir, 'leader-heartbeat.json');
  }

  /**
   * Start watching for leader health
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[watchdog] Started monitoring leader health (${this.config.agentName})`);

    this.checkInterval = setInterval(async () => {
      try {
        await this.checkLeaderHealth();
      } catch (err) {
        console.error('[watchdog] Check error:', err);
        this.emit('error', err);
      }
    }, this.config.checkIntervalMs);

    // Initial check
    this.checkLeaderHealth().catch((err) => {
      console.error('[watchdog] Initial check error:', err);
    });

    this.emit('started');
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }

    console.log(`[watchdog] Stopped monitoring (${this.config.agentName})`);
    this.emit('stopped');
  }

  /**
   * Check if current leader is healthy
   */
  private async checkLeaderHealth(): Promise<void> {
    const heartbeat = await StatelessLeadCoordinator.readHeartbeat(this.config.beadsDir);

    // No leader - trigger election
    if (!heartbeat) {
      console.log('[watchdog] No leader detected, triggering election');
      await this.triggerElection('no_leader');
      return;
    }

    // Check if this is us
    if (heartbeat.leadId === this.config.agentId) {
      this.isLeader = true;
      this.currentLeader = heartbeat;
      return;
    }

    this.isLeader = false;

    // Check if stale
    const age = Date.now() - heartbeat.timestamp;
    if (age > this.config.staleThresholdMs) {
      console.log(`[watchdog] Leader ${heartbeat.leadName} is stale (${Math.round(age / 1000)}s old)`);
      this.emit('leaderStale', { leader: heartbeat, age });
      await this.triggerElection('stale_leader');
      return;
    }

    // Leader is healthy
    if (!this.currentLeader || this.currentLeader.leadId !== heartbeat.leadId) {
      console.log(`[watchdog] Leader detected: ${heartbeat.leadName}`);
      this.emit('leaderDetected', heartbeat);
    }
    this.currentLeader = heartbeat;
  }

  /**
   * Trigger leader election
   */
  private async triggerElection(reason: string): Promise<void> {
    console.log(`[watchdog] Triggering election (reason: ${reason})`);
    this.emit('electionStarted', { reason });

    const result = await this.electLeader();

    if (result.method === 'none') {
      console.log('[watchdog] No candidates for election');
      this.emit('electionFailed', { reason: 'no_candidates' });
      return;
    }

    console.log(`[watchdog] Election result: ${result.winner} (method: ${result.method})`);
    this.emit('electionComplete', result);

    // If we won, become leader
    if (result.winnerId === this.config.agentId) {
      console.log(`[watchdog] This agent (${this.config.agentName}) won the election, becoming leader`);
      this.isLeader = true;
      await this.config.onBecomeLeader();
      this.emit('becameLeader');
    }
  }

  /**
   * Simple leader election: oldest healthy agent wins
   */
  private async electLeader(): Promise<ElectionResult> {
    const candidates = await this.config.getHealthyAgents();

    if (candidates.length === 0) {
      return {
        winner: '',
        winnerId: '',
        candidates: [],
        method: 'none',
      };
    }

    // Sort by spawn time (oldest first)
    candidates.sort((a, b) => a.spawnedAt.getTime() - b.spawnedAt.getTime());

    const winner = candidates[0];

    return {
      winner: winner.name,
      winnerId: winner.id,
      candidates: candidates.map((c) => c.name),
      method: 'oldest',
    };
  }

  /**
   * Check if this agent is currently the leader
   */
  isCurrentLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Get current leader info
   */
  getCurrentLeader(): LeadHeartbeat | null {
    return this.currentLeader;
  }

  /**
   * Get watchdog status
   */
  getStatus(): {
    isRunning: boolean;
    isLeader: boolean;
    currentLeader: LeadHeartbeat | null;
    agentName: string;
  } {
    return {
      isRunning: this.isRunning,
      isLeader: this.isLeader,
      currentLeader: this.currentLeader,
      agentName: this.config.agentName,
    };
  }
}

/**
 * Create a leader watchdog with defaults
 */
export function createLeaderWatchdog(
  beadsDir: string,
  agentName: string,
  agentId: string,
  callbacks: {
    onBecomeLeader: () => Promise<void>;
    getHealthyAgents: () => Promise<Array<{ name: string; id: string; spawnedAt: Date }>>;
  }
): LeaderWatchdog {
  return new LeaderWatchdog({
    beadsDir,
    agentName,
    agentId,
    ...callbacks,
    checkIntervalMs: 5000,
    staleThresholdMs: 30000,
  });
}
