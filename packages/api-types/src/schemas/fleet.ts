/**
 * Fleet Schemas
 *
 * Zod schemas for fleet/multi-server types used across the dashboard and API.
 */

import { z } from 'zod';
import { AgentSchema } from './agent.js';

/**
 * Peer server status enum
 */
export const PeerServerStatusSchema = z.enum(['connected', 'disconnected', 'error']);
export type PeerServerStatus = z.infer<typeof PeerServerStatusSchema>;

/**
 * Peer server schema - represents a connected server in the fleet
 */
export const PeerServerSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string().optional(),
  status: PeerServerStatusSchema,
  agentCount: z.number(),
  latency: z.number().optional(),
});
export type PeerServer = z.infer<typeof PeerServerSchema>;

/**
 * Fleet data schema - aggregate fleet information
 */
export const FleetDataSchema = z.object({
  servers: z.array(PeerServerSchema),
  agents: z.array(AgentSchema),
  totalMessages: z.number(),
});
export type FleetData = z.infer<typeof FleetDataSchema>;

/**
 * Project schema - represents a project in the fleet
 */
export const ProjectSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string().optional(),
  agents: z.array(AgentSchema),
  lead: z.object({
    name: z.string(),
    connected: z.boolean(),
  }).optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Fleet server schema (for /api/fleet/servers response)
 */
export const FleetServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['healthy', 'degraded', 'offline']),
  agents: z.array(z.object({
    name: z.string(),
    status: z.string(),
  })),
  cpuUsage: z.number(),
  memoryUsage: z.number(),
  activeConnections: z.number(),
  uptime: z.number(),
  lastHeartbeat: z.string(),
});
export type FleetServer = z.infer<typeof FleetServerSchema>;

/**
 * Fleet stats schema (for /api/fleet/stats response)
 */
export const FleetStatsSchema = z.object({
  totalAgents: z.number(),
  onlineAgents: z.number(),
  busyAgents: z.number(),
  pendingDecisions: z.number(),
  activeTasks: z.number(),
});
export type FleetStats = z.infer<typeof FleetStatsSchema>;
