/**
 * Fleet Schema Tests
 */

import { describe, it, expect } from 'vitest';
import {
  PeerServerStatusSchema,
  PeerServerSchema,
  FleetDataSchema,
  ProjectSchema,
  FleetServerSchema,
  FleetStatsSchema,
} from './fleet.js';

describe('Fleet Schemas', () => {
  describe('PeerServerStatusSchema', () => {
    it('should validate valid statuses', () => {
      expect(PeerServerStatusSchema.parse('connected')).toBe('connected');
      expect(PeerServerStatusSchema.parse('disconnected')).toBe('disconnected');
      expect(PeerServerStatusSchema.parse('error')).toBe('error');
    });

    it('should reject invalid status', () => {
      expect(() => PeerServerStatusSchema.parse('unknown')).toThrow();
    });
  });

  describe('PeerServerSchema', () => {
    it('should validate valid peer server', () => {
      const server = {
        id: 'server-1',
        url: 'http://localhost:3888',
        name: 'Primary Server',
        status: 'connected',
        agentCount: 5,
        latency: 42,
      };
      const result = PeerServerSchema.parse(server);
      expect(result.id).toBe('server-1');
      expect(result.status).toBe('connected');
      expect(result.agentCount).toBe(5);
    });

    it('should allow optional fields', () => {
      const server = {
        id: 'server-2',
        url: 'http://localhost:3889',
        status: 'disconnected',
        agentCount: 0,
      };
      const result = PeerServerSchema.parse(server);
      expect(result.name).toBeUndefined();
      expect(result.latency).toBeUndefined();
    });

    it('should reject missing required fields', () => {
      expect(() => PeerServerSchema.parse({ id: 'server-1' })).toThrow();
    });
  });

  describe('FleetDataSchema', () => {
    it('should validate fleet data with servers and agents', () => {
      const fleet = {
        servers: [
          {
            id: 'server-1',
            url: 'http://localhost:3888',
            status: 'connected',
            agentCount: 2,
          },
        ],
        agents: [
          {
            name: 'Agent1',
            status: 'online',
          },
        ],
        totalMessages: 150,
      };
      const result = FleetDataSchema.parse(fleet);
      expect(result.servers).toHaveLength(1);
      expect(result.agents).toHaveLength(1);
      expect(result.totalMessages).toBe(150);
    });

    it('should allow empty arrays', () => {
      const fleet = {
        servers: [],
        agents: [],
        totalMessages: 0,
      };
      const result = FleetDataSchema.parse(fleet);
      expect(result.servers).toHaveLength(0);
      expect(result.agents).toHaveLength(0);
    });
  });

  describe('ProjectSchema', () => {
    it('should validate project with lead', () => {
      const project = {
        id: 'proj-1',
        path: '/workspace/project',
        name: 'My Project',
        agents: [{ name: 'Worker', status: 'online' }],
        lead: {
          name: 'Lead',
          connected: true,
        },
      };
      const result = ProjectSchema.parse(project);
      expect(result.lead?.name).toBe('Lead');
      expect(result.lead?.connected).toBe(true);
    });

    it('should allow project without lead', () => {
      const project = {
        id: 'proj-2',
        path: '/workspace/other',
        agents: [],
      };
      const result = ProjectSchema.parse(project);
      expect(result.lead).toBeUndefined();
      expect(result.name).toBeUndefined();
    });
  });

  describe('FleetServerSchema', () => {
    it('should validate fleet server with all metrics', () => {
      const server = {
        id: 'fleet-server-1',
        name: 'Production Server',
        status: 'healthy',
        agents: [
          { name: 'Agent1', status: 'online' },
          { name: 'Agent2', status: 'busy' },
        ],
        cpuUsage: 45.5,
        memoryUsage: 72.3,
        activeConnections: 12,
        uptime: 86400,
        lastHeartbeat: '2025-01-22T10:00:00Z',
      };
      const result = FleetServerSchema.parse(server);
      expect(result.status).toBe('healthy');
      expect(result.agents).toHaveLength(2);
      expect(result.cpuUsage).toBe(45.5);
    });

    it('should validate degraded status', () => {
      const server = {
        id: 'fleet-server-2',
        name: 'Secondary Server',
        status: 'degraded',
        agents: [],
        cpuUsage: 95,
        memoryUsage: 88,
        activeConnections: 3,
        uptime: 3600,
        lastHeartbeat: '2025-01-22T09:59:00Z',
      };
      const result = FleetServerSchema.parse(server);
      expect(result.status).toBe('degraded');
    });

    it('should reject invalid status', () => {
      const server = {
        id: 'fleet-server-3',
        name: 'Bad Server',
        status: 'unknown',
        agents: [],
        cpuUsage: 0,
        memoryUsage: 0,
        activeConnections: 0,
        uptime: 0,
        lastHeartbeat: '2025-01-22T10:00:00Z',
      };
      expect(() => FleetServerSchema.parse(server)).toThrow();
    });
  });

  describe('FleetStatsSchema', () => {
    it('should validate complete stats', () => {
      const stats = {
        totalAgents: 10,
        onlineAgents: 7,
        busyAgents: 3,
        pendingDecisions: 2,
        activeTasks: 5,
      };
      const result = FleetStatsSchema.parse(stats);
      expect(result.totalAgents).toBe(10);
      expect(result.onlineAgents).toBe(7);
      expect(result.busyAgents).toBe(3);
    });

    it('should validate zero stats', () => {
      const stats = {
        totalAgents: 0,
        onlineAgents: 0,
        busyAgents: 0,
        pendingDecisions: 0,
        activeTasks: 0,
      };
      const result = FleetStatsSchema.parse(stats);
      expect(result.totalAgents).toBe(0);
    });

    it('should reject missing fields', () => {
      expect(() => FleetStatsSchema.parse({ totalAgents: 5 })).toThrow();
    });
  });
});
