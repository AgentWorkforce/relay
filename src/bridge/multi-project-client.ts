/**
 * MultiProjectClient
 * Connects to multiple project daemons simultaneously for cross-project orchestration.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import {
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type DeliverEnvelope,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import { encodeFrame, FrameParser } from '../protocol/framing.js';
import type { ProjectConfig, LeadInfo } from './types.js';

interface ProjectConnection {
  config: ProjectConfig;
  socket: net.Socket;
  parser: FrameParser;
  ready: boolean;
  lead?: LeadInfo;
}

export class MultiProjectClient {
  private connections: Map<string, ProjectConnection> = new Map();
  private leads: Map<string, LeadInfo> = new Map();

  /** Handler for incoming messages */
  onMessage?: (projectId: string, from: string, payload: SendPayload, messageId: string) => void;

  /** Handler for connection state changes */
  onProjectStateChange?: (projectId: string, connected: boolean) => void;

  constructor(private projects: ProjectConfig[]) {}

  /**
   * Connect to all project daemons
   */
  async connect(): Promise<void> {
    const connectPromises = this.projects.map((project) => this.connectToProject(project));
    await Promise.all(connectPromises);
  }

  /**
   * Connect to a single project daemon
   */
  private connectToProject(project: ProjectConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check socket exists
      if (!fs.existsSync(project.socketPath)) {
        console.error(`[bridge] No daemon running for ${project.id} (${project.path})`);
        console.error(`[bridge] Start with: cd ${project.path} && agent-relay up`);
        reject(new Error(`No daemon for ${project.id}`));
        return;
      }

      const socket = net.createConnection(project.socketPath, () => {
        this.sendHello(conn);
      });

      const conn: ProjectConnection = {
        config: project,
        socket,
        parser: new FrameParser(),
        ready: false,
      };

      socket.on('data', (data) => this.handleData(conn, data));

      socket.on('close', () => {
        conn.ready = false;
        this.onProjectStateChange?.(project.id, false);
      });

      socket.on('error', (err) => {
        console.error(`[bridge] Connection error for ${project.id}:`, err.message);
        if (!conn.ready) {
          reject(err);
        }
      });

      this.connections.set(project.id, conn);

      // Wait for ready
      const checkReady = setInterval(() => {
        if (conn.ready) {
          clearInterval(checkReady);
          clearTimeout(timeout);
          resolve();
        }
      }, 10);

      const timeout = setTimeout(() => {
        if (!conn.ready) {
          clearInterval(checkReady);
          socket.destroy();
          reject(new Error(`Connection timeout for ${project.id}`));
        }
      }, 5000);
    });
  }

  /**
   * Send HELLO to a project daemon
   */
  private sendHello(conn: ProjectConnection): void {
    const hello: Envelope<HelloPayload> = {
      v: PROTOCOL_VERSION,
      type: 'HELLO',
      id: uuid(),
      ts: Date.now(),
      payload: {
        agent: 'Architect',
        cli: 'bridge',
        capabilities: {
          ack: true,
          resume: false,
          max_inflight: 256,
          supports_topics: true,
        },
      },
    };

    this.send(conn, hello);
  }

  /**
   * Handle incoming data from a project connection
   */
  private handleData(conn: ProjectConnection, data: Buffer): void {
    try {
      const frames = conn.parser.push(data);
      for (const frame of frames) {
        this.processFrame(conn, frame);
      }
    } catch (err) {
      console.error(`[bridge] Parse error for ${conn.config.id}:`, err);
    }
  }

  /**
   * Process a frame from a project daemon
   */
  private processFrame(conn: ProjectConnection, envelope: Envelope): void {
    switch (envelope.type) {
      case 'WELCOME':
        conn.ready = true;
        console.log(`[bridge] Connected to ${conn.config.id}`);
        this.onProjectStateChange?.(conn.config.id, true);
        break;

      case 'DELIVER':
        this.handleDeliver(conn, envelope as DeliverEnvelope);
        break;

      case 'PING':
        this.send(conn, {
          v: PROTOCOL_VERSION,
          type: 'PONG',
          id: uuid(),
          ts: Date.now(),
          payload: (envelope.payload as { nonce?: string }) ?? {},
        });
        break;
    }
  }

  /**
   * Handle delivered message from a project
   */
  private handleDeliver(conn: ProjectConnection, envelope: DeliverEnvelope): void {
    // Send ACK
    this.send(conn, {
      v: PROTOCOL_VERSION,
      type: 'ACK',
      id: uuid(),
      ts: Date.now(),
      payload: {
        ack_id: envelope.id,
        seq: envelope.delivery.seq,
      },
    });

    // Notify handler
    if (this.onMessage && envelope.from) {
      this.onMessage(conn.config.id, envelope.from, envelope.payload, envelope.id);
    }
  }

  /**
   * Send envelope to a project daemon
   */
  private send(conn: ProjectConnection, envelope: Envelope): boolean {
    if (!conn.socket) return false;

    try {
      const frame = encodeFrame(envelope);
      conn.socket.write(frame);
      return true;
    } catch (err) {
      console.error(`[bridge] Send error for ${conn.config.id}:`, err);
      return false;
    }
  }

  /**
   * Send message to a project
   * @param projectId - Target project ID
   * @param to - Agent name within the project (or '*' for broadcast, 'lead' for project lead)
   * @param body - Message body
   */
  sendToProject(projectId: string, to: string, body: string): boolean {
    const conn = this.connections.get(projectId);
    if (!conn?.ready) {
      console.error(`[bridge] Cannot send to ${projectId}: not connected`);
      return false;
    }

    // Resolve 'lead' to actual lead name
    let targetAgent = to;
    if (to === 'lead') {
      const lead = this.leads.get(projectId);
      if (lead) {
        targetAgent = lead.name;
      } else {
        // Fallback to configured lead name
        targetAgent = conn.config.leadName;
      }
    }

    const envelope: Envelope<SendPayload> = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: uuid(),
      ts: Date.now(),
      to: targetAgent,
      payload: {
        kind: 'message',
        body,
      },
    };

    return this.send(conn, envelope);
  }

  /**
   * Broadcast to all leads
   */
  broadcastToLeads(body: string): void {
    for (const [projectId] of this.connections) {
      this.sendToProject(projectId, 'lead', body);
    }
  }

  /**
   * Broadcast to all agents in all projects
   */
  broadcastAll(body: string): void {
    for (const [projectId, conn] of this.connections) {
      if (conn.ready) {
        const envelope: Envelope<SendPayload> = {
          v: PROTOCOL_VERSION,
          type: 'SEND',
          id: uuid(),
          ts: Date.now(),
          to: '*',
          payload: {
            kind: 'message',
            body,
          },
        };
        this.send(conn, envelope);
      }
    }
  }

  /**
   * Register a lead for a project
   */
  registerLead(projectId: string, leadName: string): void {
    this.leads.set(projectId, {
      name: leadName,
      projectId,
      connected: true,
    });
  }

  /**
   * Get all connected projects
   */
  getConnectedProjects(): string[] {
    return Array.from(this.connections.entries())
      .filter(([_, conn]) => conn.ready)
      .map(([id]) => id);
  }

  /**
   * Get project connection info
   */
  getProject(projectId: string): ProjectConfig | undefined {
    return this.connections.get(projectId)?.config;
  }

  /**
   * Disconnect from all projects
   */
  disconnect(): void {
    for (const [_, conn] of this.connections) {
      try {
        this.send(conn, {
          v: PROTOCOL_VERSION,
          type: 'BYE',
          id: uuid(),
          ts: Date.now(),
          payload: {},
        });
        conn.socket.end();
      } catch {
        // Ignore
      }
    }
    this.connections.clear();
    this.leads.clear();
  }
}
