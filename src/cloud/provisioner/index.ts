/**
 * Agent Relay Cloud - Workspace Provisioner
 *
 * One-click provisioning for compute resources (Fly.io, Railway, Docker).
 */

import { getConfig } from '../config';
import { db, Workspace } from '../db';
import { vault } from '../vault';

export interface ProvisionConfig {
  userId: string;
  name: string;
  providers: string[];
  repositories: string[];
  supervisorEnabled?: boolean;
  maxAgents?: number;
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
 * Abstract provisioner interface
 */
interface ComputeProvisioner {
  provision(workspace: Workspace, credentials: Map<string, string>): Promise<{
    computeId: string;
    publicUrl: string;
  }>;
  deprovision(workspace: Workspace): Promise<void>;
  getStatus(workspace: Workspace): Promise<WorkspaceStatus>;
  restart(workspace: Workspace): Promise<void>;
}

/**
 * Fly.io provisioner
 */
class FlyProvisioner implements ComputeProvisioner {
  private apiToken: string;
  private org: string;

  constructor() {
    const config = getConfig();
    if (!config.compute.fly) {
      throw new Error('Fly.io configuration missing');
    }
    this.apiToken = config.compute.fly.apiToken;
    this.org = config.compute.fly.org;
  }

  async provision(
    workspace: Workspace,
    credentials: Map<string, string>
  ): Promise<{ computeId: string; publicUrl: string }> {
    const appName = `ar-${workspace.id.substring(0, 8)}`;

    // Create Fly app
    const createResponse = await fetch('https://api.machines.dev/v1/apps', {
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

    if (!createResponse.ok) {
      const error = await createResponse.text();
      throw new Error(`Failed to create Fly app: ${error}`);
    }

    // Set secrets (credentials)
    const secrets: Record<string, string> = {};
    for (const [provider, token] of credentials) {
      secrets[`${provider.toUpperCase()}_TOKEN`] = token;
    }

    await fetch(`https://api.machines.dev/v1/apps/${appName}/secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(secrets),
    });

    // Create machine
    const machineResponse = await fetch(
      `https://api.machines.dev/v1/apps/${appName}/machines`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          config: {
            image: 'ghcr.io/agent-relay/workspace:latest',
            env: {
              WORKSPACE_ID: workspace.id,
              SUPERVISOR_ENABLED: String(workspace.config.supervisorEnabled),
              MAX_AGENTS: String(workspace.config.maxAgents),
              REPOSITORIES: workspace.config.repositories.join(','),
              PROVIDERS: workspace.config.providers.join(','),
            },
            services: [
              {
                ports: [
                  { port: 443, handlers: ['tls', 'http'] },
                  { port: 80, handlers: ['http'] },
                ],
                protocol: 'tcp',
                internal_port: 3000,
              },
            ],
            guest: {
              cpu_kind: 'shared',
              cpus: 1,
              memory_mb: 512,
            },
          },
        }),
      }
    );

    if (!machineResponse.ok) {
      const error = await machineResponse.text();
      throw new Error(`Failed to create Fly machine: ${error}`);
    }

    const machine = await machineResponse.json();

    return {
      computeId: machine.id,
      publicUrl: `https://${appName}.fly.dev`,
    };
  }

  async deprovision(workspace: Workspace): Promise<void> {
    const appName = `ar-${workspace.id.substring(0, 8)}`;

    await fetch(`https://api.machines.dev/v1/apps/${appName}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async getStatus(workspace: Workspace): Promise<WorkspaceStatus> {
    if (!workspace.computeId) return 'error';

    const appName = `ar-${workspace.id.substring(0, 8)}`;

    const response = await fetch(
      `https://api.machines.dev/v1/apps/${appName}/machines/${workspace.computeId}`,
      {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      }
    );

    if (!response.ok) return 'error';

    const machine = await response.json();

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

    await fetch(
      `https://api.machines.dev/v1/apps/${appName}/machines/${workspace.computeId}/restart`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      }
    );
  }
}

/**
 * Railway provisioner
 */
class RailwayProvisioner implements ComputeProvisioner {
  private apiToken: string;

  constructor() {
    const config = getConfig();
    if (!config.compute.railway) {
      throw new Error('Railway configuration missing');
    }
    this.apiToken = config.compute.railway.apiToken;
  }

  async provision(
    workspace: Workspace,
    credentials: Map<string, string>
  ): Promise<{ computeId: string; publicUrl: string }> {
    // Create project
    const projectResponse = await fetch('https://backboard.railway.app/graphql/v2', {
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

    const projectData = await projectResponse.json();
    const projectId = projectData.data.projectCreate.id;

    // Deploy service
    const serviceResponse = await fetch('https://backboard.railway.app/graphql/v2', {
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
              image: 'ghcr.io/agent-relay/workspace:latest',
            },
          },
        },
      }),
    });

    const serviceData = await serviceResponse.json();
    const serviceId = serviceData.data.serviceCreate.id;

    // Set environment variables
    const envVars: Record<string, string> = {
      WORKSPACE_ID: workspace.id,
      SUPERVISOR_ENABLED: String(workspace.config.supervisorEnabled),
      MAX_AGENTS: String(workspace.config.maxAgents),
      REPOSITORIES: workspace.config.repositories.join(','),
      PROVIDERS: workspace.config.providers.join(','),
    };

    for (const [provider, token] of credentials) {
      envVars[`${provider.toUpperCase()}_TOKEN`] = token;
    }

    await fetch('https://backboard.railway.app/graphql/v2', {
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
    const domainResponse = await fetch('https://backboard.railway.app/graphql/v2', {
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

    const domainData = await domainResponse.json();
    const domain = domainData.data.serviceDomainCreate.domain;

    return {
      computeId: projectId,
      publicUrl: `https://${domain}`,
    };
  }

  async deprovision(workspace: Workspace): Promise<void> {
    if (!workspace.computeId) return;

    await fetch('https://backboard.railway.app/graphql/v2', {
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

    const response = await fetch('https://backboard.railway.app/graphql/v2', {
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

    const data = await response.json();
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

    await fetch('https://backboard.railway.app/graphql/v2', {
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
  async provision(
    workspace: Workspace,
    credentials: Map<string, string>
  ): Promise<{ computeId: string; publicUrl: string }> {
    const containerName = `ar-${workspace.id.substring(0, 8)}`;

    // Build environment variables
    const envArgs: string[] = [
      `-e WORKSPACE_ID=${workspace.id}`,
      `-e SUPERVISOR_ENABLED=${workspace.config.supervisorEnabled}`,
      `-e MAX_AGENTS=${workspace.config.maxAgents}`,
      `-e REPOSITORIES=${workspace.config.repositories.join(',')}`,
      `-e PROVIDERS=${workspace.config.providers.join(',')}`,
    ];

    for (const [provider, token] of credentials) {
      envArgs.push(`-e ${provider.toUpperCase()}_TOKEN=${token}`);
    }

    // Run container
    const { execSync } = await import('child_process');
    const port = 3000 + Math.floor(Math.random() * 1000);

    try {
      execSync(
        `docker run -d --name ${containerName} -p ${port}:3000 ${envArgs.join(' ')} ghcr.io/agent-relay/workspace:latest`,
        { stdio: 'pipe' }
      );

      return {
        computeId: containerName,
        publicUrl: `http://localhost:${port}`,
      };
    } catch (error) {
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

    // Get credentials
    const credentials = new Map<string, string>();
    for (const provider of config.providers) {
      const cred = await vault.getCredential(config.userId, provider);
      if (cred) {
        credentials.set(provider, cred.accessToken);
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
}

// Singleton instance
let _provisioner: WorkspaceProvisioner | null = null;

export function getProvisioner(): WorkspaceProvisioner {
  if (!_provisioner) {
    _provisioner = new WorkspaceProvisioner();
  }
  return _provisioner;
}
