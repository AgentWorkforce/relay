/**
 * Health Worker Manager
 *
 * Manages the health check worker thread, sending periodic stats updates
 * and handling worker lifecycle.
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface HealthWorkerConfig {
  /** Port for health check server (default: main port + 1) */
  port: number;
  /** Interval for sending stats updates (default: 5000ms) */
  statsInterval?: number;
}

export interface HealthStatsProvider {
  getUptime: () => number;
  getMemoryMB: () => number;
  getRelayConnected: () => boolean;
  getAgentCount: () => number;
  getStatus: () => 'healthy' | 'busy' | 'degraded';
}

export class HealthWorkerManager {
  private worker: Worker | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private config: HealthWorkerConfig;
  private statsProvider: HealthStatsProvider;
  private ready = false;

  constructor(config: HealthWorkerConfig, statsProvider: HealthStatsProvider) {
    this.config = {
      statsInterval: 5000,
      ...config,
    };
    this.statsProvider = statsProvider;
  }

  /**
   * Start the health worker thread
   */
  async start(): Promise<void> {
    if (this.worker) {
      console.warn('[health-manager] Worker already running');
      return;
    }

    return new Promise((resolve, reject) => {
      // Worker script path - handle both dev (src) and prod (dist)
      const workerPath = path.join(__dirname, 'health-worker.js');

      this.worker = new Worker(workerPath, {
        workerData: { port: this.config.port },
      });

      this.worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          this.ready = true;
          console.log(`[health-manager] Worker ready on port ${msg.port}`);
          this.startStatsUpdates();
          resolve();
        } else if (msg.type === 'error') {
          console.error('[health-manager] Worker error:', msg.error);
        }
      });

      this.worker.on('error', (err) => {
        console.error('[health-manager] Worker thread error:', err);
        if (!this.ready) {
          reject(err);
        }
      });

      this.worker.on('exit', (code) => {
        console.log(`[health-manager] Worker exited with code ${code}`);
        this.ready = false;
        this.worker = null;
        this.stopStatsUpdates();
      });

      // Timeout for worker startup
      setTimeout(() => {
        if (!this.ready) {
          reject(new Error('Health worker startup timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Stop the health worker thread
   */
  async stop(): Promise<void> {
    this.stopStatsUpdates();

    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }

  /**
   * Check if worker is ready
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get the port the health worker is listening on
   */
  getPort(): number {
    return this.config.port;
  }

  /**
   * Start periodic stats updates to worker
   */
  private startStatsUpdates(): void {
    if (this.statsInterval) return;

    // Send initial stats
    this.sendStats();

    // Send periodic updates
    this.statsInterval = setInterval(() => {
      this.sendStats();
    }, this.config.statsInterval);
  }

  /**
   * Stop stats updates
   */
  private stopStatsUpdates(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * Send current stats to worker
   */
  private sendStats(): void {
    if (!this.worker || !this.ready) return;

    try {
      const stats = {
        uptime: this.statsProvider.getUptime(),
        memoryMB: this.statsProvider.getMemoryMB(),
        relayConnected: this.statsProvider.getRelayConnected(),
        agentCount: this.statsProvider.getAgentCount(),
        status: this.statsProvider.getStatus(),
      };

      this.worker.postMessage(stats);
    } catch (err) {
      console.error('[health-manager] Failed to send stats:', err);
    }
  }
}

/** Default health port offset from main port */
export const HEALTH_PORT_OFFSET = 1;

/**
 * Calculate health port from main port
 */
export function getHealthPort(mainPort: number): number {
  return mainPort + HEALTH_PORT_OFFSET;
}
