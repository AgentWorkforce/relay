/**
 * Agent Relay Cloud - Workspace Provisioner
 *
 * One-click provisioning for compute resources (Fly.io, Railway, Docker).
 */

import * as crypto from 'crypto';
import { getConfig } from '../config.js';
import { db, Workspace } from '../db/index.js';
import { vault } from '../vault/index.js';
import { nangoService } from '../services/nango.js';

const WORKSPACE_PORT = 3888;
const FETCH_TIMEOUT_MS = 10_000;
const WORKSPACE_IMAGE = process.env.WORKSPACE_IMAGE || 'ghcr.io/agentworkforce/relay-workspace:latest';

// ============================================================================
// Provisioning Stage Tracking
// ============================================================================

export type ProvisioningStage =
  | 'creating'
  | 'networking'
  | 'secrets'
  | 'machine'
  | 'booting'
  | 'health'
  | 'complete';

interface ProvisioningProgress {
  stage: ProvisioningStage;
  startedAt: number;
  updatedAt: number;
}

// In-memory tracker for provisioning progress (workspace ID -> progress)
const provisioningProgress = new Map<string, ProvisioningProgress>();

/**
 * Update the provisioning stage for a workspace
 */
function updateProvisioningStage(workspaceId: string, stage: ProvisioningStage): void {
  const existing = provisioningProgress.get(workspaceId);
  provisioningProgress.set(workspaceId, {
    stage,
    startedAt: existing?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
  });
  console.log(`[provisioner] Workspace ${workspaceId.substring(0, 8)} stage: ${stage}`);
}

/**
 * Get the current provisioning stage for a workspace
 */
export function getProvisioningStage(workspaceId: string): ProvisioningProgress | null {
  return provisioningProgress.get(workspaceId) ?? null;
}

/**
 * Clear provisioning progress (call when complete or failed)
 */
function clearProvisioningProgress(workspaceId: string): void {
  provisioningProgress.delete(workspaceId);
}

/**
 * Get a fresh GitHub App installation token from Nango.
 * Looks up the user's connected repositories to find a valid Nango connection.
 */
async function getGithubAppTokenForUser(userId: string): Promise<string | null> {
  try {
    // Find any repository with a Nango connection for this user
    const repos = await db.repositories.findByUserId(userId);
    const repoWithConnection = repos.find(r => r.nangoConnectionId);

    if (!repoWithConnection?.nangoConnectionId) {
      console.warn(`[provisioner] No Nango GitHub App connection found for user ${userId}`);
      return null;
    }

    // Get fresh installation token from Nango (handles refresh automatically)
    const token = await nangoService.getGithubAppToken(repoWithConnection.nangoConnectionId);
    return token;
  } catch (error) {
    console.error(`[provisioner] Failed to get GitHub App token for user ${userId}:`, error);
    return null;
  }
}

async function loadCredentialToken(userId: string, provider: string): Promise<string | null> {
  try {
    const cred = await vault.getCredential(userId, provider);
    if (cred?.accessToken) {
      return cred.accessToken;
    }
  } catch (error) {
    console.warn(`Failed to decrypt ${provider} credential from vault; trying raw storage fallback`, error);
    const raw = await db.credentials.findByUserAndProvider(userId, provider);
    return raw?.accessToken ?? null;
  }
  return null;
}

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit & { retries?: number } = {},
): Promise<Response> {
  const retries = options.retries ?? 2;
  let attempt = 0;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok && response.status >= 500 && attempt < retries) {
        attempt += 1;
        await wait(500 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (attempt >= retries) {
        throw error;
      }
      attempt += 1;
      await wait(500 * attempt);
    }
  }

  throw new Error('fetchWithRetry exhausted retries');
}

async function softHealthCheck(url: string): Promise<void> {
  try {
    const res = await fetchWithRetry(`${url.replace(/\/$/, '')}/health`, { method: 'GET', retries: 1 });
    if (!res.ok) {
      console.warn(`[health] Non-200 from ${url}/health: ${res.status}`);
    }
  } catch (error) {
    console.warn(`[health] Failed to reach ${url}/health`, error);
  }
}

/**
 * Wait for machine to be in "started" state
 */
async function waitForMachineStarted(
  apiToken: string,
  appName: string,
  machineId: string,
  maxWaitMs = 60_000
): Promise<void> {
  const startTime = Date.now();
  let lastState = 'unknown';

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const res = await fetch(
        `https://api.machines.dev/v1/apps/${appName}/machines/${machineId}`,
        {
          headers: { Authorization: `Bearer ${apiToken}` },
        }
      );

      if (res.ok) {
        const machine = (await res.json()) as { state: string };
        lastState = machine.state;
        console.log(`[provisioner] Machine ${machineId} state: ${lastState}`);

        if (lastState === 'started') {
          return;
        }

        // If stopped/suspended, try to start it
        if (lastState === 'stopped' || lastState === 'suspended') {
          console.log(`[provisioner] Starting machine ${machineId}...`);
          await fetch(
            `https://api.machines.dev/v1/apps/${appName}/machines/${machineId}/start`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiToken}` },
            }
          );
        }
      }
    } catch (error) {
      console.warn(`[provisioner] Error checking machine state:`, error);
    }

    await wait(3000);
  }

  throw new Error(`Machine ${machineId} did not start within ${maxWaitMs}ms (last state: ${lastState})`);
}

/**
 * Wait for health check to pass (with DNS propagation time)
 * Tries internal Fly network first if available, then falls back to public URL
 */
async function waitForHealthy(
  url: string,
  appName?: string,
  maxWaitMs = 90_000
): Promise<void> {
  const startTime = Date.now();

  // Build list of URLs to try - internal first (faster, more reliable from inside Fly)
  const urlsToTry: string[] = [];

  // If running on Fly and app name provided, try internal network first
  const isOnFly = !!process.env.FLY_APP_NAME;
  if (isOnFly && appName) {
    urlsToTry.push(`http://${appName}.internal:8080/health`);
  }

  // Always add the public URL as fallback
  urlsToTry.push(`${url.replace(/\/$/, '')}/health`);

  console.log(
    `[provisioner] Waiting for workspace to become healthy (trying: ${urlsToTry.join(', ')})...`
  );

  while (Date.now() - startTime < maxWaitMs) {
    // Try each URL in order
    for (const healthUrl of urlsToTry) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);

        const res = await fetch(healthUrl, {
          method: 'GET',
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (res.ok) {
          console.log(`[provisioner] Health check passed via ${healthUrl}`);
          return;
        }

        console.log(
          `[provisioner] Health check to ${healthUrl} returned ${res.status}`
        );
      } catch (error) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const errMsg = (error as Error).message;
        // Only log detailed error for last URL attempt
        if (healthUrl === urlsToTry[urlsToTry.length - 1]) {
          console.log(
            `[provisioner] Health check failed (${elapsed}s elapsed): ${errMsg}`
          );
        }
      }
    }

    await wait(3000);
  }

  // Don't throw - workspace is provisioned, health check is best-effort
  console.warn(
    `[provisioner] Health check did not pass within ${maxWaitMs}ms, continuing anyway`
  );
}

export interface ProvisionConfig {
  userId: string;
  name: string;
  providers: string[];
  repositories: string[];
  supervisorEnabled?: boolean;
  maxAgents?: number;
  /** Direct GitHub token for testing (bypasses Nango lookup) */
  githubToken?: string;
}

export interface ProvisionResult {
  workspaceId: string;
  status: 'provisioning' | 'running' | 'error';
  publicUrl?: string;
  error?: string;
}

export type WorkspaceStatus = Workspace['status'];
export { Workspace };

/**
 * Resource tier configurations for vertical scaling
 */
export interface ResourceTier {
  name: 'small' | 'medium' | 'large' | 'xlarge';
  cpuCores: number;
  memoryMb: number;
  maxAgents: number;
}

export const RESOURCE_TIERS: Record<string, ResourceTier> = {
  small: { name: 'small', cpuCores: 1, memoryMb: 512, maxAgents: 5 },
  medium: { name: 'medium', cpuCores: 2, memoryMb: 1024, maxAgents: 10 },
  large: { name: 'large', cpuCores: 4, memoryMb: 2048, maxAgents: 20 },
  xlarge: { name: 'xlarge', cpuCores: 8, memoryMb: 4096, maxAgents: 50 },
};

/**
 * Abstract provisioner interface - adapter pattern for multiple providers
 * Supports both Kubernetes, Fly.io, Railway, Docker, etc.
 */
interface ComputeProvisioner {
  provision(workspace: Workspace, credentials: Map<string, string>): Promise<{
    computeId: string;
    publicUrl: string;
  }>;
  deprovision(workspace: Workspace): Promise<void>;
  getStatus(workspace: Workspace): Promise<WorkspaceStatus>;
  restart(workspace: Workspace): Promise<void>;

  // Vertical scaling - resize workspace resources
  resize?(workspace: Workspace, tier: ResourceTier): Promise<void>;

  // Update max agent limit
  updateAgentLimit?(workspace: Workspace, newLimit: number): Promise<void>;

  // Get current resource tier
  getCurrentTier?(workspace: Workspace): Promise<ResourceTier>;
}

/**
 * Fly.io provisioner
 */
class FlyProvisioner implements ComputeProvisioner {
  private apiToken: string;
  private org: string;
  private region: string;
  private workspaceDomain?: string;
  private cloudApiUrl: string;
  private sessionSecret: string;
  private registryAuth?: { username: string; password: string };

  constructor() {
    const config = getConfig();
    if (!config.compute.fly) {
      throw new Error('Fly.io configuration missing');
    }
    this.apiToken = config.compute.fly.apiToken;
    this.org = config.compute.fly.org;
    this.region = config.compute.fly.region || 'sjc';
    this.workspaceDomain = config.compute.fly.workspaceDomain;
    this.registryAuth = config.compute.fly.registryAuth;
    this.cloudApiUrl = config.publicUrl;
    this.sessionSecret = config.sessionSecret;
  }

  /**
   * Generate a workspace token for API authentication
   * This is a simple HMAC - in production, consider using JWTs
   */
  private generateWorkspaceToken(workspaceId: string): string {
    return crypto
      .createHmac('sha256', this.sessionSecret)
      .update(`workspace:${workspaceId}`)
      .digest('hex');
  }

  async provision(
    workspace: Workspace,
    credentials: Map<string, string>
  ): Promise<{ computeId: string; publicUrl: string }> {
    const appName = `ar-${workspace.id.substring(0, 8)}`;

    // Stage: Creating workspace
    updateProvisioningStage(workspace.id, 'creating');

    // Create Fly app
    await fetchWithRetry('https://api.machines.dev/v1/apps', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_name: appName,
        org_slug: this.org,
      }),
    });

    // Stage: Networking
    updateProvisioningStage(workspace.id, 'networking');

    // Allocate IPs for the app (required for public DNS)
    // Must use GraphQL API - Machines REST API doesn't support IP allocation
    // Shared IPv4 is free, IPv6 is free
    console.log(`[fly] Allocating IPs for ${appName}...`);
    const allocateIP = async (type: 'shared_v4' | 'v6'): Promise<boolean> => {
      try {
        // Map our type to Fly GraphQL enum
        const graphqlType = type === 'shared_v4' ? 'shared_v4' : 'v6';
        const res = await fetchWithRetry('https://api.fly.io/graphql', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `
              mutation AllocateIPAddress($input: AllocateIPAddressInput!) {
                allocateIpAddress(input: $input) {
                  ipAddress {
                    id
                    address
                    type
                  }
                }
              }
            `,
            variables: {
              input: {
                appId: appName,
                type: graphqlType,
              },
            },
          }),
        });
        if (!res.ok) {
          const errorText = await res.text();
          console.warn(`[fly] Failed to allocate ${type}: ${res.status} ${errorText}`);
          return false;
        }
        const data = await res.json() as {
          data?: { allocateIpAddress?: { ipAddress?: { address?: string } } };
          errors?: Array<{ message: string }>;
        };
        if (data.errors?.length) {
          // Ignore "already allocated" errors
          const alreadyAllocated = data.errors.some(e =>
            e.message.includes('already') || e.message.includes('exists')
          );
          if (!alreadyAllocated) {
            console.warn(`[fly] GraphQL error allocating ${type}: ${data.errors[0].message}`);
            return false;
          }
          console.log(`[fly] IP ${type} already allocated`);
          return true;
        }
        const address = data.data?.allocateIpAddress?.ipAddress?.address;
        console.log(`[fly] Allocated ${type}: ${address}`);
        return true;
      } catch (err) {
        console.warn(`[fly] Failed to allocate ${type}: ${(err as Error).message}`);
        return false;
      }
    };

    const [sharedV4Result, v6Result] = await Promise.all([
      allocateIP('shared_v4'),
      allocateIP('v6'),
    ]);
    console.log(`[fly] IP allocation results: shared_v4=${sharedV4Result}, v6=${v6Result}`);

    // Stage: Secrets
    updateProvisioningStage(workspace.id, 'secrets');

    // Set secrets (provider credentials)
    const secrets: Record<string, string> = {};
    for (const [provider, token] of credentials) {
      secrets[`${provider.toUpperCase()}_TOKEN`] = token;
    }

    if (Object.keys(secrets).length > 0) {
      await fetchWithRetry(`https://api.machines.dev/v1/apps/${appName}/secrets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(secrets),
      });
    }

    // If custom workspace domain is configured, add certificate
    const customHostname = this.workspaceDomain
      ? `${appName}.${this.workspaceDomain}`
      : null;

    if (customHostname) {
      await this.allocateCertificate(appName, customHostname);
    }

    // Stage: Machine
    updateProvisioningStage(workspace.id, 'machine');

    // Create machine with auto-stop/start for cost optimization
    const machineResponse = await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/machines`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          region: this.region,
          config: {
            image: WORKSPACE_IMAGE,
            // Registry auth for private ghcr.io images
            ...(this.registryAuth && {
              image_registry_auth: {
                registry: 'ghcr.io',
                username: this.registryAuth.username,
                password: this.registryAuth.password,
              },
            }),
            env: {
              WORKSPACE_ID: workspace.id,
              SUPERVISOR_ENABLED: String(workspace.config.supervisorEnabled ?? false),
              MAX_AGENTS: String(workspace.config.maxAgents ?? 10),
              REPOSITORIES: (workspace.config.repositories ?? []).join(','),
              PROVIDERS: (workspace.config.providers ?? []).join(','),
              PORT: String(WORKSPACE_PORT),
              AGENT_RELAY_DASHBOARD_PORT: String(WORKSPACE_PORT),
              // Git gateway configuration
              CLOUD_API_URL: this.cloudApiUrl,
              WORKSPACE_TOKEN: this.generateWorkspaceToken(workspace.id),
            },
            services: [
              {
                ports: [
                  {
                    port: 443,
                    handlers: ['tls', 'http'],
                    // Force HTTP/1.1 to backend for WebSocket upgrade compatibility
                    // HTTP/2 doesn't support traditional WebSocket upgrade mechanism
                    http_options: {
                      h2_backend: false,
                    },
                  },
                  { port: 80, handlers: ['http'] },
                ],
                protocol: 'tcp',
                internal_port: WORKSPACE_PORT,
                // Auto-stop after 5 minutes of inactivity
                auto_stop_machines: true,
                auto_start_machines: true,
                min_machines_running: 0,
              },
            ],
            checks: {
              health: {
                type: 'http',
                port: WORKSPACE_PORT,
                path: '/health',
                interval: '30s',
                timeout: '5s',
                grace_period: '10s',
              },
            },
            guest: {
              cpu_kind: 'shared',
              cpus: 2,
              memory_mb: 2048,
            },
          },
        }),
      }
    );

    if (!machineResponse.ok) {
      const error = await machineResponse.text();
      throw new Error(`Failed to create Fly machine: ${error}`);
    }

    const machine = (await machineResponse.json()) as { id: string };

    // Return custom domain URL if configured, otherwise default fly.dev
    const publicUrl = customHostname
      ? `https://${customHostname}`
      : `https://${appName}.fly.dev`;

    // Stage: Booting
    updateProvisioningStage(workspace.id, 'booting');

    // Wait for machine to be in started state
    await waitForMachineStarted(this.apiToken, appName, machine.id);

    // Stage: Health check
    updateProvisioningStage(workspace.id, 'health');

    // Wait for health check to pass (includes DNS propagation time)
    // Pass appName to enable internal Fly network health checks
    await waitForHealthy(publicUrl, appName);

    // Stage: Complete
    updateProvisioningStage(workspace.id, 'complete');

    return {
      computeId: machine.id,
      publicUrl,
    };
  }

  /**
   * Allocate SSL certificate for custom domain
   */
  private async allocateCertificate(
    appName: string,
    hostname: string
  ): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/certificates`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hostname }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      // Don't fail if cert already exists
      if (!error.includes('already exists')) {
        throw new Error(`Failed to allocate certificate for ${hostname}: ${error}`);
      }
    }
  }

  async deprovision(workspace: Workspace): Promise<void> {
    const appName = `ar-${workspace.id.substring(0, 8)}`;

    await fetchWithRetry(`https://api.machines.dev/v1/apps/${appName}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async getStatus(workspace: Workspace): Promise<WorkspaceStatus> {
    if (!workspace.computeId) return 'error';

    const appName = `ar-${workspace.id.substring(0, 8)}`;

    const response = await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/machines/${workspace.computeId}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      }
    );

    if (!response.ok) return 'error';

    const machine = await response.json() as { state: string };

    switch (machine.state) {
      case 'started':
        return 'running';
      case 'stopped':
        return 'stopped';
      case 'created':
      case 'starting':
        return 'provisioning';
      default:
        return 'error';
    }
  }

  async restart(workspace: Workspace): Promise<void> {
    if (!workspace.computeId) return;

    const appName = `ar-${workspace.id.substring(0, 8)}`;

    await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/machines/${workspace.computeId}/restart`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      }
    );
  }

  /**
   * Resize workspace - vertical scaling via Fly Machines API
   */
  async resize(workspace: Workspace, tier: ResourceTier): Promise<void> {
    if (!workspace.computeId) return;

    const appName = `ar-${workspace.id.substring(0, 8)}`;

    // Update machine configuration
    await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/machines/${workspace.computeId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: {
            guest: {
              cpu_kind: tier.cpuCores <= 2 ? 'shared' : 'performance',
              cpus: tier.cpuCores,
              memory_mb: tier.memoryMb,
            },
            env: {
              MAX_AGENTS: String(tier.maxAgents),
            },
          },
        }),
      }
    );

    console.log(`[fly] Resized workspace ${workspace.id} to ${tier.name} (${tier.cpuCores} CPU, ${tier.memoryMb}MB RAM)`);
  }

  /**
   * Update the max agent limit for a workspace
   */
  async updateAgentLimit(workspace: Workspace, newLimit: number): Promise<void> {
    if (!workspace.computeId) return;

    const appName = `ar-${workspace.id.substring(0, 8)}`;

    // Update environment variable
    await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/machines/${workspace.computeId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: {
            env: {
              MAX_AGENTS: String(newLimit),
            },
          },
        }),
      }
    );

    console.log(`[fly] Updated workspace ${workspace.id} agent limit to ${newLimit}`);
  }

  /**
   * Get current resource tier for a workspace
   */
  async getCurrentTier(workspace: Workspace): Promise<ResourceTier> {
    if (!workspace.computeId) {
      return RESOURCE_TIERS.small;
    }

    const appName = `ar-${workspace.id.substring(0, 8)}`;

    const response = await fetchWithRetry(
      `https://api.machines.dev/v1/apps/${appName}/machines/${workspace.computeId}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      }
    );

    if (!response.ok) {
      return RESOURCE_TIERS.small;
    }

    const machine = await response.json() as {
      config?: { guest?: { cpus?: number; memory_mb?: number } };
    };

    const _cpus = machine.config?.guest?.cpus || 1;
    const memoryMb = machine.config?.guest?.memory_mb || 512;

    // Map to nearest tier
    if (memoryMb >= 4096) return RESOURCE_TIERS.xlarge;
    if (memoryMb >= 2048) return RESOURCE_TIERS.large;
    if (memoryMb >= 1024) return RESOURCE_TIERS.medium;
    return RESOURCE_TIERS.small;
  }
}

/**
 * Railway provisioner
 */
class RailwayProvisioner implements ComputeProvisioner {
  private apiToken: string;
  private cloudApiUrl: string;
  private sessionSecret: string;

  constructor() {
    const config = getConfig();
    if (!config.compute.railway) {
      throw new Error('Railway configuration missing');
    }
    this.apiToken = config.compute.railway.apiToken;
    this.cloudApiUrl = config.publicUrl;
    this.sessionSecret = config.sessionSecret;
  }

  private generateWorkspaceToken(workspaceId: string): string {
    return crypto
      .createHmac('sha256', this.sessionSecret)
      .update(`workspace:${workspaceId}`)
      .digest('hex');
  }

  async provision(
    workspace: Workspace,
    credentials: Map<string, string>
  ): Promise<{ computeId: string; publicUrl: string }> {
    // Create project
    const projectResponse = await fetchWithRetry('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation CreateProject($input: ProjectCreateInput!) {
            projectCreate(input: $input) {
              id
              name
            }
          }
        `,
        variables: {
          input: {
            name: `agent-relay-${workspace.id.substring(0, 8)}`,
          },
        },
      }),
    });

    const projectData = await projectResponse.json() as { data: { projectCreate: { id: string } } };
    const projectId = projectData.data.projectCreate.id;

    // Deploy service
    const serviceResponse = await fetchWithRetry('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation CreateService($input: ServiceCreateInput!) {
            serviceCreate(input: $input) {
              id
            }
          }
        `,
        variables: {
          input: {
            projectId,
            name: 'workspace',
            source: {
              image: WORKSPACE_IMAGE,
            },
          },
        },
      }),
    });

    const serviceData = await serviceResponse.json() as { data: { serviceCreate: { id: string } } };
    const serviceId = serviceData.data.serviceCreate.id;

    // Set environment variables
    const envVars: Record<string, string> = {
      WORKSPACE_ID: workspace.id,
      SUPERVISOR_ENABLED: String(workspace.config.supervisorEnabled ?? false),
      MAX_AGENTS: String(workspace.config.maxAgents ?? 10),
      REPOSITORIES: (workspace.config.repositories ?? []).join(','),
      PROVIDERS: (workspace.config.providers ?? []).join(','),
      PORT: String(WORKSPACE_PORT),
      AGENT_RELAY_DASHBOARD_PORT: String(WORKSPACE_PORT),
      CLOUD_API_URL: this.cloudApiUrl,
      WORKSPACE_TOKEN: this.generateWorkspaceToken(workspace.id),
    };

    for (const [provider, token] of credentials) {
      envVars[`${provider.toUpperCase()}_TOKEN`] = token;
    }

    await fetchWithRetry('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation SetVariables($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
          }
        `,
        variables: {
          input: {
            projectId,
            serviceId,
            variables: envVars,
          },
        },
      }),
    });

    // Generate domain
    const domainResponse = await fetchWithRetry('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation CreateDomain($input: ServiceDomainCreateInput!) {
            serviceDomainCreate(input: $input) {
              domain
            }
          }
        `,
        variables: {
          input: {
            serviceId,
          },
        },
      }),
    });

    const domainData = await domainResponse.json() as { data: { serviceDomainCreate: { domain: string } } };
    const domain = domainData.data.serviceDomainCreate.domain;

    await softHealthCheck(`https://${domain}`);

    return {
      computeId: projectId,
      publicUrl: `https://${domain}`,
    };
  }

  async deprovision(workspace: Workspace): Promise<void> {
    if (!workspace.computeId) return;

    await fetchWithRetry('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation DeleteProject($id: String!) {
            projectDelete(id: $id)
          }
        `,
        variables: {
          id: workspace.computeId,
        },
      }),
    });
  }

  async getStatus(workspace: Workspace): Promise<WorkspaceStatus> {
    if (!workspace.computeId) return 'error';

    const response = await fetchWithRetry('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          query GetProject($id: String!) {
            project(id: $id) {
              deployments {
                edges {
                  node {
                    status
                  }
                }
              }
            }
          }
        `,
        variables: {
          id: workspace.computeId,
        },
      }),
    });

    const data = await response.json() as {
      data?: { project?: { deployments?: { edges: Array<{ node: { status: string } }> } } }
    };
    const deployments = data.data?.project?.deployments?.edges;

    if (!deployments || deployments.length === 0) return 'provisioning';

    const latestStatus = deployments[0].node.status;

    switch (latestStatus) {
      case 'SUCCESS':
        return 'running';
      case 'BUILDING':
      case 'DEPLOYING':
        return 'provisioning';
      case 'CRASHED':
      case 'FAILED':
        return 'error';
      default:
        return 'stopped';
    }
  }

  async restart(workspace: Workspace): Promise<void> {
    // Railway doesn't have a direct restart - redeploy instead
    if (!workspace.computeId) return;

    await fetchWithRetry('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation RedeployService($input: DeploymentTriggerInput!) {
            deploymentTrigger(input: $input)
          }
        `,
        variables: {
          input: {
            projectId: workspace.computeId,
          },
        },
      }),
    });
  }
}

/**
 * Local Docker provisioner (for development/self-hosted)
 */
class DockerProvisioner implements ComputeProvisioner {
  private cloudApiUrl: string;
  private cloudApiUrlForContainer: string;
  private sessionSecret: string;

  constructor() {
    const config = getConfig();
    this.cloudApiUrl = config.publicUrl;
    this.sessionSecret = config.sessionSecret;

    // For Docker containers, localhost won't work - they need to reach the host
    // Convert localhost URLs to host.docker.internal for container access
    if (this.cloudApiUrl.includes('localhost') || this.cloudApiUrl.includes('127.0.0.1')) {
      this.cloudApiUrlForContainer = this.cloudApiUrl
        .replace('localhost', 'host.docker.internal')
        .replace('127.0.0.1', 'host.docker.internal');
      console.log(`[docker] Container API URL: ${this.cloudApiUrlForContainer} (host: ${this.cloudApiUrl})`);
    } else {
      this.cloudApiUrlForContainer = this.cloudApiUrl;
    }
  }

  private generateWorkspaceToken(workspaceId: string): string {
    return crypto
      .createHmac('sha256', this.sessionSecret)
      .update(`workspace:${workspaceId}`)
      .digest('hex');
  }

  /**
   * Wait for container to be healthy by polling the health endpoint
   */
  private async waitForHealthy(publicUrl: string, timeoutMs: number = 60_000): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 2000;

    console.log(`[docker] Waiting for container to be healthy at ${publicUrl}...`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${publicUrl}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });

        if (response.ok) {
          console.log(`[docker] Container healthy after ${Date.now() - startTime}ms`);
          return;
        }
      } catch {
        // Container not ready yet, continue polling
      }

      await wait(pollInterval);
    }

    throw new Error(`Container did not become healthy within ${timeoutMs}ms`);
  }

  async provision(
    workspace: Workspace,
    credentials: Map<string, string>
  ): Promise<{ computeId: string; publicUrl: string }> {
    const containerName = `ar-${workspace.id.substring(0, 8)}`;

    // Build environment variables
    const envArgs: string[] = [
      `-e WORKSPACE_ID=${workspace.id}`,
      `-e SUPERVISOR_ENABLED=${workspace.config.supervisorEnabled ?? false}`,
      `-e MAX_AGENTS=${workspace.config.maxAgents ?? 10}`,
      `-e REPOSITORIES=${(workspace.config.repositories ?? []).join(',')}`,
      `-e PROVIDERS=${(workspace.config.providers ?? []).join(',')}`,
      `-e PORT=${WORKSPACE_PORT}`,
      `-e AGENT_RELAY_DASHBOARD_PORT=${WORKSPACE_PORT}`,
      `-e CLOUD_API_URL=${this.cloudApiUrlForContainer}`,
      `-e WORKSPACE_TOKEN=${this.generateWorkspaceToken(workspace.id)}`,
    ];

    for (const [provider, token] of credentials) {
      envArgs.push(`-e ${provider.toUpperCase()}_TOKEN=${token}`);
    }

    // Run container
    const { execSync } = await import('child_process');
    const hostPort = 3000 + Math.floor(Math.random() * 1000);

    // When running in Docker, connect to the same network for container-to-container communication
    const runningInDocker = process.env.RUNNING_IN_DOCKER === 'true';
    const networkArg = runningInDocker ? '--network agent-relay-dev' : '';

    // In development, mount local dist and docs folders for faster iteration
    // Set WORKSPACE_DEV_MOUNT=true to enable
    const devMount = process.env.WORKSPACE_DEV_MOUNT === 'true';
    const volumeArgs = devMount
      ? `-v "${process.cwd()}/dist:/app/dist:ro" -v "${process.cwd()}/docs:/app/docs:ro"`
      : '';
    if (devMount) {
      console.log('[provisioner] Dev mode: mounting local dist/ and docs/ folders into workspace container');
    }

    try {
      execSync(
        `docker run -d --user root --name ${containerName} ${networkArg} ${volumeArgs} -p ${hostPort}:${WORKSPACE_PORT} ${envArgs.join(' ')} ${WORKSPACE_IMAGE}`,
        { stdio: 'pipe' }
      );

      const publicUrl = `http://localhost:${hostPort}`;

      // Wait for container to be healthy before returning
      // When running in Docker, use the internal container name for health check
      const healthCheckUrl = runningInDocker
        ? `http://${containerName}:${WORKSPACE_PORT}`
        : publicUrl;
      await this.waitForHealthy(healthCheckUrl);

      return {
        computeId: containerName,
        publicUrl,
      };
    } catch (error) {
      // Clean up container if it was created but health check failed
      try {
        const { execSync: execSyncCleanup } = await import('child_process');
        execSyncCleanup(`docker rm -f ${containerName}`, { stdio: 'pipe' });
      } catch {
        // Ignore cleanup errors
      }
      throw new Error(`Failed to start Docker container: ${error}`);
    }
  }

  async deprovision(workspace: Workspace): Promise<void> {
    if (!workspace.computeId) return;

    const { execSync } = await import('child_process');
    try {
      execSync(`docker rm -f ${workspace.computeId}`, { stdio: 'pipe' });
    } catch {
      // Container may already be removed
    }
  }

  async getStatus(workspace: Workspace): Promise<WorkspaceStatus> {
    if (!workspace.computeId) return 'error';

    const { execSync } = await import('child_process');
    try {
      const result = execSync(
        `docker inspect -f '{{.State.Status}}' ${workspace.computeId}`,
        { stdio: 'pipe' }
      ).toString().trim();

      switch (result) {
        case 'running':
          return 'running';
        case 'exited':
        case 'dead':
          return 'stopped';
        case 'created':
        case 'restarting':
          return 'provisioning';
        default:
          return 'error';
      }
    } catch {
      return 'error';
    }
  }

  async restart(workspace: Workspace): Promise<void> {
    if (!workspace.computeId) return;

    const { execSync } = await import('child_process');
    try {
      execSync(`docker restart ${workspace.computeId}`, { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Failed to restart container: ${error}`);
    }
  }
}

/**
 * Main Workspace Provisioner
 */
export class WorkspaceProvisioner {
  private provisioner: ComputeProvisioner;

  constructor() {
    const config = getConfig();

    switch (config.compute.provider) {
      case 'fly':
        this.provisioner = new FlyProvisioner();
        break;
      case 'railway':
        this.provisioner = new RailwayProvisioner();
        break;
      case 'docker':
      default:
        this.provisioner = new DockerProvisioner();
    }
  }

  /**
   * Provision a new workspace (one-click)
   */
  async provision(config: ProvisionConfig): Promise<ProvisionResult> {
    // Create workspace record
    const workspace = await db.workspaces.create({
      userId: config.userId,
      name: config.name,
      computeProvider: getConfig().compute.provider,
      config: {
        providers: config.providers,
        repositories: config.repositories,
        supervisorEnabled: config.supervisorEnabled ?? true,
        maxAgents: config.maxAgents ?? 10,
      },
    });

    // Add creator as owner in workspace_members for team collaboration support
    await db.workspaceMembers.addMember({
      workspaceId: workspace.id,
      userId: config.userId,
      role: 'owner',
      invitedBy: config.userId, // Self-invited as creator
    });
    // Auto-accept the creator's membership
    await db.workspaceMembers.acceptInvite(workspace.id, config.userId);

    // Get credentials
    const credentials = new Map<string, string>();
    for (const provider of config.providers) {
      const token = await loadCredentialToken(config.userId, provider);
      if (token) {
        credentials.set(provider, token);
      }
    }

    // GitHub token is required for cloning repositories
    // Use direct token if provided (for testing), otherwise get from Nango
    if (config.repositories.length > 0) {
      if (config.githubToken) {
        // Direct token provided (for testing)
        credentials.set('github', config.githubToken);
        console.log('[provisioner] Using provided GitHub token');
      } else {
        // Get fresh installation token from Nango GitHub App
        const githubToken = await getGithubAppTokenForUser(config.userId);
        if (githubToken) {
          credentials.set('github', githubToken);
        } else {
          console.warn(`[provisioner] No GitHub App token for user ${config.userId}; repository cloning may fail.`);
        }
      }
    }

    // Provision compute
    try {
      const { computeId, publicUrl } = await this.provisioner.provision(
        workspace,
        credentials
      );

      await db.workspaces.updateStatus(workspace.id, 'running', {
        computeId,
        publicUrl,
      });

      return {
        workspaceId: workspace.id,
        status: 'running',
        publicUrl,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await db.workspaces.updateStatus(workspace.id, 'error', {
        errorMessage,
      });

      return {
        workspaceId: workspace.id,
        status: 'error',
        error: errorMessage,
      };
    }
  }

  /**
   * Deprovision a workspace
   */
  async deprovision(workspaceId: string): Promise<void> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    await this.provisioner.deprovision(workspace);
    await db.workspaces.delete(workspaceId);
  }

  /**
   * Get workspace status
   */
  async getStatus(workspaceId: string): Promise<WorkspaceStatus> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    const status = await this.provisioner.getStatus(workspace);

    // Update database if status changed
    if (status !== workspace.status) {
      await db.workspaces.updateStatus(workspaceId, status);
    }

    return status;
  }

  /**
   * Restart a workspace
   */
  async restart(workspaceId: string): Promise<void> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    await this.provisioner.restart(workspace);
  }

  /**
   * Stop a workspace
   */
  async stop(workspaceId: string): Promise<void> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    // For now, just deprovision to stop
    await this.provisioner.deprovision(workspace);
    await db.workspaces.updateStatus(workspaceId, 'stopped');
  }

  /**
   * Resize a workspace (vertical scaling)
   */
  async resize(workspaceId: string, tier: ResourceTier): Promise<void> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    if (!this.provisioner.resize) {
      throw new Error('Resize not supported by current compute provider');
    }

    await this.provisioner.resize(workspace, tier);

    // Update workspace config with new limits
    await db.workspaces.updateConfig(workspaceId, {
      ...workspace.config,
      maxAgents: tier.maxAgents,
      resourceTier: tier.name,
    });
  }

  /**
   * Update the max agent limit for a workspace
   */
  async updateAgentLimit(workspaceId: string, newLimit: number): Promise<void> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    if (this.provisioner.updateAgentLimit) {
      await this.provisioner.updateAgentLimit(workspace, newLimit);
    }

    // Update workspace config
    await db.workspaces.updateConfig(workspaceId, {
      ...workspace.config,
      maxAgents: newLimit,
    });
  }

  /**
   * Get current resource tier for a workspace
   */
  async getCurrentTier(workspaceId: string): Promise<ResourceTier> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    if (this.provisioner.getCurrentTier) {
      return this.provisioner.getCurrentTier(workspace);
    }

    // Fallback: determine from config or default to small
    const tierName = workspace.config.resourceTier || 'small';
    return RESOURCE_TIERS[tierName] || RESOURCE_TIERS.small;
  }
}

// Singleton instance
let _provisioner: WorkspaceProvisioner | null = null;

export function getProvisioner(): WorkspaceProvisioner {
  if (!_provisioner) {
    _provisioner = new WorkspaceProvisioner();
  }
  return _provisioner;
}
