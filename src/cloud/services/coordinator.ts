/**
 * Coordinator Agent Service
 *
 * Manages lifecycle of coordinator agents for project groups.
 * Coordinators oversee and orchestrate work across repositories in a group.
 */

import { db, ProjectGroup, Repository, CoordinatorAgentConfig } from '../db/index.js';
import { createClient, RedisClientType } from 'redis';
import { getConfig } from '../config.js';

/**
 * Coordinator agent state
 */
interface CoordinatorState {
  groupId: string;
  groupName: string;
  agentName: string;
  model: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  startedAt?: Date;
  stoppedAt?: Date;
  error?: string;
  repositories: Repository[];
}

/**
 * In-memory coordinator state tracker
 * In production, this would be persisted to database or Redis
 */
const coordinatorStates = new Map<string, CoordinatorState>();

export interface CoordinatorService {
  start(groupId: string): Promise<void>;
  stop(groupId: string): Promise<void>;
  restart(groupId: string): Promise<void>;
  getStatus(groupId: string): Promise<CoordinatorState | null>;
  listActive(): Promise<CoordinatorState[]>;
}

/**
 * Start a coordinator agent for a project group
 */
async function start(groupId: string): Promise<void> {
  const group = await db.projectGroups.findById(groupId);
  if (!group) {
    throw new Error('Project group not found');
  }

  if (!group.coordinatorAgent?.enabled) {
    throw new Error('Coordinator is not enabled for this group');
  }

  const repositories = await db.repositories.findByProjectGroupId(groupId);
  if (repositories.length === 0) {
    throw new Error('Cannot start coordinator for empty group');
  }

  const config = group.coordinatorAgent;
  const agentName = config.name || `${group.name} Coordinator`;
  const model = config.model || 'claude-sonnet-4-5';

  // Check if already running
  const existing = coordinatorStates.get(groupId);
  if (existing && existing.status === 'running') {
    console.log(`Coordinator for group ${groupId} is already running`);
    return;
  }

  // Update state to starting
  const state: CoordinatorState = {
    groupId,
    groupName: group.name,
    agentName,
    model,
    status: 'starting',
    repositories,
  };
  coordinatorStates.set(groupId, state);

  try {
    // Spawn the coordinator agent
    // In a real implementation, this would:
    // 1. Connect to agent-relay daemon or cloud workspace
    // 2. Spawn agent with configured name and model
    // 3. Provide system prompt with group context
    // 4. Configure capabilities (read repos, create PRs, etc.)

    await spawnCoordinatorAgent(group, config, repositories);

    // Update state to running
    state.status = 'running';
    state.startedAt = new Date();
    coordinatorStates.set(groupId, state);

    console.log(`Coordinator agent started for group ${groupId}: ${agentName}`);
  } catch (error) {
    state.status = 'error';
    state.error = error instanceof Error ? error.message : 'Unknown error';
    coordinatorStates.set(groupId, state);
    throw error;
  }
}

/**
 * Stop a coordinator agent for a project group
 */
async function stop(groupId: string): Promise<void> {
  const state = coordinatorStates.get(groupId);
  if (!state) {
    // Not running, nothing to do
    return;
  }

  if (state.status === 'stopped') {
    return;
  }

  // Update state to stopping
  state.status = 'stopping';
  coordinatorStates.set(groupId, state);

  try {
    // Stop the coordinator agent
    // In a real implementation, this would:
    // 1. Send stop signal to the agent
    // 2. Wait for graceful shutdown
    // 3. Clean up resources

    await stopCoordinatorAgent(groupId, state);

    // Update state to stopped
    state.status = 'stopped';
    state.stoppedAt = new Date();
    coordinatorStates.set(groupId, state);

    console.log(`Coordinator agent stopped for group ${groupId}`);
  } catch (error) {
    state.status = 'error';
    state.error = error instanceof Error ? error.message : 'Unknown error';
    coordinatorStates.set(groupId, state);
    throw error;
  }
}

/**
 * Restart a coordinator agent
 */
async function restart(groupId: string): Promise<void> {
  await stop(groupId);
  await start(groupId);
}

/**
 * Get status of a coordinator agent
 */
async function getStatus(groupId: string): Promise<CoordinatorState | null> {
  return coordinatorStates.get(groupId) || null;
}

/**
 * List all active coordinators
 */
async function listActive(): Promise<CoordinatorState[]> {
  return Array.from(coordinatorStates.values()).filter(
    (state) => state.status === 'running' || state.status === 'starting'
  );
}

/**
 * Redis pub/sub for cross-workspace messaging
 */
let pubClient: RedisClientType | null = null;
let subClient: RedisClientType | null = null;
const messageHandlers = new Map<string, (message: CrossWorkspaceMessage) => void>();

interface CrossWorkspaceMessage {
  type: 'relay' | 'status' | 'command';
  from: string;
  fromWorkspace: string;
  to: string;
  toWorkspace?: string;
  body: string;
  thread?: string;
  timestamp: string;
}

/**
 * Initialize Redis pub/sub clients
 */
async function initRedisClients(): Promise<void> {
  if (pubClient && subClient) return;

  const config = getConfig();

  pubClient = createClient({ url: config.redisUrl });
  subClient = createClient({ url: config.redisUrl });

  await pubClient.connect();
  await subClient.connect();

  // Subscribe to coordinator channel
  await subClient.subscribe('coordinator:messages', (message) => {
    try {
      const parsed = JSON.parse(message) as CrossWorkspaceMessage;
      const handler = messageHandlers.get(parsed.toWorkspace || '*');
      if (handler) {
        handler(parsed);
      }
    } catch (error) {
      console.error('Failed to parse coordinator message:', error);
    }
  });

  console.log('[coordinator] Redis pub/sub initialized');
}

/**
 * Send a message from coordinator to a workspace
 */
export async function sendToWorkspace(
  coordinatorGroupId: string,
  targetWorkspaceId: string,
  agentName: string,
  message: string,
  thread?: string
): Promise<void> {
  if (!pubClient) {
    await initRedisClients();
  }

  const crossMessage: CrossWorkspaceMessage = {
    type: 'relay',
    from: 'Coordinator',
    fromWorkspace: `coordinator:${coordinatorGroupId}`,
    to: agentName,
    toWorkspace: targetWorkspaceId,
    body: message,
    thread,
    timestamp: new Date().toISOString(),
  };

  await pubClient!.publish('workspace:messages', JSON.stringify(crossMessage));
  console.log(`[coordinator] Sent message to ${targetWorkspaceId}:${agentName}`);
}

/**
 * Broadcast a message to all workspaces in a project group
 */
export async function broadcastToGroup(
  coordinatorGroupId: string,
  message: string,
  thread?: string
): Promise<void> {
  if (!pubClient) {
    await initRedisClients();
  }

  const group = await db.projectGroups.findById(coordinatorGroupId);
  if (!group) {
    throw new Error('Project group not found');
  }

  const repositories = await db.repositories.findByProjectGroupId(coordinatorGroupId);

  // Get all workspaces containing these repositories
  const workspaceIds = new Set<string>();
  for (const repo of repositories) {
    if (repo.workspaceId) {
      workspaceIds.add(repo.workspaceId);
    }
  }

  const crossMessage: CrossWorkspaceMessage = {
    type: 'relay',
    from: 'Coordinator',
    fromWorkspace: `coordinator:${coordinatorGroupId}`,
    to: '*',
    body: message,
    thread,
    timestamp: new Date().toISOString(),
  };

  // Broadcast to each workspace
  for (const workspaceId of workspaceIds) {
    crossMessage.toWorkspace = workspaceId;
    await pubClient!.publish('workspace:messages', JSON.stringify(crossMessage));
  }

  console.log(`[coordinator] Broadcast to ${workspaceIds.size} workspace(s)`);
}

/**
 * Spawn the actual coordinator agent
 */
async function spawnCoordinatorAgent(
  group: ProjectGroup,
  config: CoordinatorAgentConfig,
  repositories: Repository[]
): Promise<void> {
  // Initialize Redis for cross-workspace messaging
  await initRedisClients();

  // Build system prompt for the coordinator
  const systemPrompt = buildCoordinatorSystemPrompt(group, config, repositories);

  // Get workspaces for the repositories
  const workspaceIds = new Set<string>();
  for (const repo of repositories) {
    if (repo.workspaceId) {
      workspaceIds.add(repo.workspaceId);
    }
  }

  const workspaces = await Promise.all(
    Array.from(workspaceIds).map(id => db.workspaces.findById(id))
  );

  console.log(`[coordinator] Spawning coordinator agent: ${config.name || group.name}`);
  console.log(`[coordinator] Model: ${config.model || 'claude-sonnet-4-5'}`);
  console.log(`[coordinator] Repositories: ${repositories.map((r) => r.githubFullName).join(', ')}`);
  console.log(`[coordinator] Connected workspaces: ${workspaces.filter(Boolean).length}`);

  // Register message handler for this coordinator
  messageHandlers.set(`coordinator:${group.id}`, async (message) => {
    console.log(`[coordinator:${group.id}] Received: ${message.body.substring(0, 100)}...`);

    // In a full implementation, this would:
    // 1. Parse the message for coordinator commands
    // 2. Route to appropriate workspace(s)
    // 3. Track conversation state
  });

  // Store coordinator connection info in Redis for workspace discovery
  if (pubClient) {
    await pubClient.hSet(`coordinator:${group.id}`, {
      groupId: group.id,
      groupName: group.name,
      agentName: config.name || `${group.name} Coordinator`,
      model: config.model || 'claude-sonnet-4-5',
      startedAt: new Date().toISOString(),
      workspaces: JSON.stringify(Array.from(workspaceIds)),
      systemPrompt,
    });
    await pubClient.expire(`coordinator:${group.id}`, 86400); // 24h TTL
  }
}

/**
 * Stop the actual coordinator agent
 */
async function stopCoordinatorAgent(groupId: string, state: CoordinatorState): Promise<void> {
  console.log(`[coordinator] Stopping coordinator agent for group ${groupId}: ${state.agentName}`);

  // Remove message handler
  messageHandlers.delete(`coordinator:${groupId}`);

  // Remove from Redis
  if (pubClient) {
    await pubClient.del(`coordinator:${groupId}`);
  }
}

/**
 * Route a message from a workspace to the coordinator
 */
export async function routeToCoordinator(
  workspaceId: string,
  agentName: string,
  message: string,
  thread?: string
): Promise<void> {
  if (!pubClient) {
    await initRedisClients();
  }

  // Find which coordinator is managing this workspace
  // by scanning all coordinator keys
  const coordinatorKeys = await pubClient!.keys('coordinator:*');

  for (const key of coordinatorKeys) {
    if (key === 'coordinator:messages') continue; // Skip the channel

    const data = await pubClient!.hGetAll(key);
    if (data.workspaces) {
      const workspaces = JSON.parse(data.workspaces) as string[];
      if (workspaces.includes(workspaceId)) {
        // Found the coordinator for this workspace
        const crossMessage: CrossWorkspaceMessage = {
          type: 'relay',
          from: agentName,
          fromWorkspace: workspaceId,
          to: 'Coordinator',
          toWorkspace: key,
          body: message,
          thread,
          timestamp: new Date().toISOString(),
        };

        await pubClient!.publish('coordinator:messages', JSON.stringify(crossMessage));
        console.log(`[coordinator] Routed message from ${workspaceId}:${agentName} to ${key}`);
        return;
      }
    }
  }

  console.warn(`[coordinator] No coordinator found for workspace ${workspaceId}`);
}

/**
 * Get all active coordinators
 */
export async function getActiveCoordinators(): Promise<Array<{
  groupId: string;
  groupName: string;
  agentName: string;
  model: string;
  startedAt: string;
  workspaces: string[];
}>> {
  if (!pubClient) {
    await initRedisClients();
  }

  const coordinatorKeys = await pubClient!.keys('coordinator:*');
  const coordinators = [];

  for (const key of coordinatorKeys) {
    if (key === 'coordinator:messages') continue;

    const data = await pubClient!.hGetAll(key);
    if (data.groupId) {
      coordinators.push({
        groupId: data.groupId,
        groupName: data.groupName,
        agentName: data.agentName,
        model: data.model,
        startedAt: data.startedAt,
        workspaces: data.workspaces ? JSON.parse(data.workspaces) : [],
      });
    }
  }

  return coordinators;
}

/**
 * Build system prompt for coordinator agent
 */
function buildCoordinatorSystemPrompt(
  group: ProjectGroup,
  config: CoordinatorAgentConfig,
  repositories: Repository[]
): string {
  const repoList = repositories.map((r) => r.githubFullName).join('\n- ');

  let prompt = `You are the coordinator agent for the "${group.name}" project group.

Your role is to oversee and orchestrate work across the following repositories:
- ${repoList}

`;

  if (config.capabilities && config.capabilities.length > 0) {
    prompt += `You have the following capabilities:
${config.capabilities.map((c) => `- ${c}`).join('\n')}

`;
  }

  if (config.systemPrompt) {
    prompt += `${config.systemPrompt}\n\n`;
  }

  prompt += `When coordinating work:
1. Monitor all repositories in your group
2. Identify dependencies and coordination points
3. Delegate tasks to project-specific agents when appropriate
4. Ensure consistency across repositories
5. Report status and blockers to the team

Use the Agent Relay messaging system to communicate with other agents and team members.`;

  return prompt;
}

/**
 * Singleton instance
 */
let coordinatorServiceInstance: CoordinatorService | null = null;

/**
 * Get the coordinator service singleton
 */
export function getCoordinatorService(): CoordinatorService {
  if (!coordinatorServiceInstance) {
    coordinatorServiceInstance = {
      start,
      stop,
      restart,
      getStatus,
      listActive,
    };
  }
  return coordinatorServiceInstance;
}

/**
 * Initialize coordinator service
 * Restarts any coordinators that should be running
 */
export async function initializeCoordinatorService(): Promise<void> {
  console.log('Initializing coordinator service...');

  // In a production system, this would:
  // 1. Query database for all enabled coordinators
  // 2. Check their expected state
  // 3. Restart any that should be running

  // For now, just log initialization
  console.log('Coordinator service initialized');
}
