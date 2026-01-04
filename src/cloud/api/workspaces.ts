/**
 * Workspaces API Routes
 *
 * One-click workspace provisioning and management.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { db, Workspace } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';
import { checkWorkspaceLimit } from './middleware/planLimits.js';

export const workspacesRouter = Router();

// All routes require authentication
workspacesRouter.use(requireAuth);

/**
 * GET /api/workspaces
 * List user's workspaces
 */
workspacesRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const workspaces = await db.workspaces.findByUserId(userId);

    res.json({
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        publicUrl: w.publicUrl,
        providers: w.config.providers,
        repositories: w.config.repositories,
        createdAt: w.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing workspaces:', error);
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

/**
 * POST /api/workspaces
 * Create (provision) a new workspace
 */
workspacesRouter.post('/', checkWorkspaceLimit, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { name, providers, repositories, supervisorEnabled, maxAgents } = req.body;

  // Validation
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required' });
  }

  if (!providers || !Array.isArray(providers) || providers.length === 0) {
    return res.status(400).json({ error: 'At least one provider is required' });
  }

  if (!repositories || !Array.isArray(repositories)) {
    return res.status(400).json({ error: 'Repositories array is required' });
  }

  // Verify user has credentials for all providers
  const credentials = await db.credentials.findByUserId(userId);
  const connectedProviders = new Set(credentials.map((c) => c.provider));

  for (const provider of providers) {
    if (!connectedProviders.has(provider)) {
      return res.status(400).json({
        error: `Provider ${provider} not connected. Please connect it first.`,
      });
    }
  }

  try {
    const provisioner = getProvisioner();
    const result = await provisioner.provision({
      userId,
      name,
      providers,
      repositories,
      supervisorEnabled,
      maxAgents,
    });

    if (result.status === 'error') {
      return res.status(500).json({
        error: 'Failed to provision workspace',
        details: result.error,
      });
    }

    res.status(201).json({
      workspaceId: result.workspaceId,
      status: result.status,
      publicUrl: result.publicUrl,
    });
  } catch (error) {
    console.error('Error creating workspace:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

/**
 * GET /api/workspaces/:id
 * Get workspace details
 */
workspacesRouter.get('/:id', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Get repositories assigned to this workspace
    const repositories = await db.repositories.findByWorkspaceId(id);

    res.json({
      id: workspace.id,
      name: workspace.name,
      status: workspace.status,
      publicUrl: workspace.publicUrl,
      computeProvider: workspace.computeProvider,
      config: workspace.config,
      errorMessage: workspace.errorMessage,
      repositories: repositories.map((r) => ({
        id: r.id,
        fullName: r.githubFullName,
        syncStatus: r.syncStatus,
        lastSyncedAt: r.lastSyncedAt,
      })),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  } catch (error) {
    console.error('Error getting workspace:', error);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

/**
 * GET /api/workspaces/:id/status
 * Get current workspace status (polls compute provider)
 */
workspacesRouter.get('/:id/status', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    const status = await provisioner.getStatus(id);

    res.json({ status });
  } catch (error) {
    console.error('Error getting workspace status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * POST /api/workspaces/:id/restart
 * Restart a workspace
 */
workspacesRouter.post('/:id/restart', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    await provisioner.restart(id);

    res.json({ success: true, message: 'Workspace restarting' });
  } catch (error) {
    console.error('Error restarting workspace:', error);
    res.status(500).json({ error: 'Failed to restart workspace' });
  }
});

/**
 * POST /api/workspaces/:id/stop
 * Stop a workspace
 */
workspacesRouter.post('/:id/stop', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    await provisioner.stop(id);

    res.json({ success: true, message: 'Workspace stopped' });
  } catch (error) {
    console.error('Error stopping workspace:', error);
    res.status(500).json({ error: 'Failed to stop workspace' });
  }
});

/**
 * DELETE /api/workspaces/:id
 * Delete (deprovision) a workspace
 */
workspacesRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const provisioner = getProvisioner();
    await provisioner.deprovision(id);

    res.json({ success: true, message: 'Workspace deleted' });
  } catch (error) {
    console.error('Error deleting workspace:', error);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

/**
 * POST /api/workspaces/:id/repos
 * Add repositories to a workspace
 */
workspacesRouter.post('/:id/repos', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { repositoryIds } = req.body;

  if (!repositoryIds || !Array.isArray(repositoryIds)) {
    return res.status(400).json({ error: 'repositoryIds array is required' });
  }

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Assign repositories to workspace
    for (const repoId of repositoryIds) {
      await db.repositories.assignToWorkspace(repoId, id);
    }

    res.json({ success: true, message: 'Repositories added' });
  } catch (error) {
    console.error('Error adding repos to workspace:', error);
    res.status(500).json({ error: 'Failed to add repositories' });
  }
});

/**
 * POST /api/workspaces/:id/domain
 * Add or update custom domain (Premium feature - Team/Enterprise only)
 */
workspacesRouter.post('/:id/domain', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { domain } = req.body;

  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: 'Domain is required' });
  }

  // Basic domain validation
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  if (!domainRegex.test(domain)) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Check if user has premium plan (Team/Enterprise)
    const user = await db.users.findById(userId);
    const hasPremium = user?.plan === 'team' || user?.plan === 'enterprise';
    if (!hasPremium) {
      return res.status(402).json({
        error: 'Custom domains require Team or Enterprise plan',
        upgrade: '/settings/billing',
      });
    }

    // Check if domain is already in use
    const existing = await db.workspaces.findByCustomDomain(domain);
    if (existing && existing.id !== id) {
      return res.status(409).json({ error: 'Domain already in use' });
    }

    // Set the custom domain (pending verification)
    await db.workspaces.setCustomDomain(id, domain, 'pending');

    // Return DNS instructions
    res.json({
      success: true,
      domain,
      status: 'pending',
      instructions: {
        type: 'CNAME',
        name: domain,
        value: workspace.publicUrl?.replace('https://', '') || `${id}.agentrelay.dev`,
        ttl: 300,
      },
      verifyEndpoint: `/api/workspaces/${id}/domain/verify`,
      message: 'Add the CNAME record to your DNS, then call the verify endpoint',
    });
  } catch (error) {
    console.error('Error setting custom domain:', error);
    res.status(500).json({ error: 'Failed to set custom domain' });
  }
});

/**
 * POST /api/workspaces/:id/domain/verify
 * Verify custom domain DNS is configured correctly
 */
workspacesRouter.post('/:id/domain/verify', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!workspace.customDomain) {
      return res.status(400).json({ error: 'No custom domain configured' });
    }

    // Verify DNS resolution
    const dns = await import('dns').then(m => m.promises);
    try {
      const records = await dns.resolveCname(workspace.customDomain);
      const expectedTarget = workspace.publicUrl?.replace('https://', '') || `${id}.agentrelay.dev`;

      if (records.some(r => r.includes(expectedTarget) || r.includes('agentrelay'))) {
        // DNS is configured, now provision SSL cert
        await db.workspaces.updateCustomDomainStatus(id, 'verifying');

        // Trigger SSL cert provisioning on compute provider
        // For Railway/Fly, this is automatic once domain is added
        await provisionDomainSSL(workspace);

        await db.workspaces.updateCustomDomainStatus(id, 'active');

        res.json({
          success: true,
          status: 'active',
          domain: workspace.customDomain,
          message: 'Custom domain verified and SSL certificate provisioned',
        });
      } else {
        res.status(400).json({
          success: false,
          status: 'pending',
          error: 'DNS not configured correctly',
          expected: expectedTarget,
          found: records,
        });
      }
    } catch (_dnsError) {
      res.status(400).json({
        success: false,
        status: 'pending',
        error: 'Could not resolve domain. DNS may not be configured yet.',
      });
    }
  } catch (error) {
    console.error('Error verifying domain:', error);
    res.status(500).json({ error: 'Failed to verify domain' });
  }
});

/**
 * DELETE /api/workspaces/:id/domain
 * Remove custom domain
 */
workspacesRouter.delete('/:id/domain', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Remove from compute provider
    if (workspace.customDomain) {
      await removeDomainFromCompute(workspace);
    }

    await db.workspaces.removeCustomDomain(id);

    res.json({ success: true, message: 'Custom domain removed' });
  } catch (error) {
    console.error('Error removing domain:', error);
    res.status(500).json({ error: 'Failed to remove domain' });
  }
});

/**
 * Helper: Provision SSL for custom domain on compute provider
 */
async function provisionDomainSSL(workspace: Workspace): Promise<void> {
  const config = (await import('../config.js')).getConfig();

  if (workspace.computeProvider === 'fly' && config.compute.fly) {
    // Fly.io: Add certificate
    await fetch(`https://api.machines.dev/v1/apps/ar-${workspace.id.substring(0, 8)}/certificates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.compute.fly.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: workspace.customDomain }),
    });
  } else if (workspace.computeProvider === 'railway' && config.compute.railway) {
    // Railway: Add custom domain via GraphQL
    await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.compute.railway.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `
          mutation AddCustomDomain($input: CustomDomainCreateInput!) {
            customDomainCreate(input: $input) { id }
          }
        `,
        variables: {
          input: {
            projectId: workspace.computeId,
            domain: workspace.customDomain,
          },
        },
      }),
    });
  }
  // Docker: Would need reverse proxy config (Caddy/nginx)
}

/**
 * Helper: Remove custom domain from compute provider
 */
async function removeDomainFromCompute(workspace: Workspace): Promise<void> {
  const config = (await import('../config.js')).getConfig();

  if (workspace.computeProvider === 'fly' && config.compute.fly) {
    await fetch(
      `https://api.machines.dev/v1/apps/ar-${workspace.id.substring(0, 8)}/certificates/${workspace.customDomain}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${config.compute.fly.apiToken}` },
      }
    );
  }
  // Railway and Docker: similar cleanup
}

/**
 * POST /api/workspaces/:id/connect-provider
 * Trigger CLI login flow for a provider (claude, codex, opencode, droid)
 * Returns the OAuth URL for the user to complete authentication
 */
const PROVIDER_CLI_COMMANDS: Record<string, { command: string; displayName: string }> = {
  anthropic: { command: 'claude', displayName: 'Claude' },
  codex: { command: 'codex login', displayName: 'Codex' },
  opencode: { command: 'opencode', displayName: 'OpenCode' },
  droid: { command: 'droid', displayName: 'Droid' },
};

workspacesRouter.post('/:id/connect-provider', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id } = req.params;
  const { provider } = req.body;

  const providerConfig = PROVIDER_CLI_COMMANDS[provider];
  if (!provider || !providerConfig) {
    return res.status(400).json({
      error: 'Valid provider is required',
      validProviders: Object.keys(PROVIDER_CLI_COMMANDS),
    });
  }

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (workspace.status !== 'running') {
      return res.status(400).json({ error: 'Workspace must be running to connect providers' });
    }

    const containerName = workspace.computeId;

    if (!containerName) {
      return res.status(400).json({ error: 'Workspace has no compute instance' });
    }

    // Run the CLI login command in the container and capture output
    const { execSync } = await import('child_process');

    try {
      // For Docker containers, run the command and capture the OAuth URL
      // The CLI typically outputs something like:
      // "Please visit https://... to authenticate"
      const output = execSync(
        `docker exec ${containerName} timeout 10 ${providerConfig.command} 2>&1 || true`,
        { encoding: 'utf-8', timeout: 15000 }
      );

      // Parse OAuth URL from output
      const urlMatch = output.match(/https:\/\/[^\s]+/);

      if (urlMatch) {
        res.json({
          success: true,
          provider,
          authUrl: urlMatch[0],
          message: `Visit the URL to authenticate with ${providerConfig.displayName}`,
          instructions: [
            '1. Click the authentication URL below',
            '2. Complete the login in your browser',
            '3. Return here - your workspace will automatically detect the credentials',
          ],
        });
      } else {
        // CLI might already be authenticated or returned different output
        res.json({
          success: false,
          provider,
          output: output.substring(0, 500), // First 500 chars for debugging
          message: 'Could not extract authentication URL. The provider may already be connected.',
        });
      }
    } catch (execError) {
      const errorMsg = execError instanceof Error ? execError.message : 'Unknown error';
      console.error(`[workspace] CLI login error for ${provider}:`, errorMsg);

      res.status(500).json({
        error: 'Failed to start authentication flow',
        details: errorMsg,
      });
    }
  } catch (error) {
    console.error('Error connecting provider:', error);
    res.status(500).json({ error: 'Failed to connect provider' });
  }
});

/**
 * POST /api/workspaces/:id/proxy/*
 * Proxy API requests to the workspace container
 * This allows the dashboard to make REST calls through the cloud server
 */
workspacesRouter.all('/:id/proxy/{*proxyPath}', async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { id, proxyPath } = req.params;

  try {
    const workspace = await db.workspaces.findById(id);

    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (workspace.status !== 'running' || !workspace.publicUrl) {
      return res.status(400).json({ error: 'Workspace is not running' });
    }

    // Forward the request to the workspace
    const targetUrl = `${workspace.publicUrl}/api/${proxyPath}`;

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const proxyRes = await fetch(targetUrl, fetchOptions);
    const data = await proxyRes.json();

    res.status(proxyRes.status).json(data);
  } catch (error) {
    console.error('[workspace-proxy] Error:', error);
    res.status(500).json({ error: 'Failed to proxy request to workspace' });
  }
});

/**
 * POST /api/workspaces/quick
 * Quick provision: one-click with defaults
 * Providers are optional - can be connected after workspace creation via CLI login
 */
workspacesRouter.post('/quick', checkWorkspaceLimit, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { name, repositoryFullName } = req.body;

  if (!repositoryFullName) {
    return res.status(400).json({ error: 'Repository name is required' });
  }

  try {
    // Get user's connected providers (optional now)
    const credentials = await db.credentials.findByUserId(userId);
    const providers = credentials
      .filter((c) => c.provider !== 'github')
      .map((c) => c.provider);

    // Create workspace with defaults
    const provisioner = getProvisioner();
    const workspaceName = name || `Workspace for ${repositoryFullName}`;

    const result = await provisioner.provision({
      userId,
      name: workspaceName,
      providers: providers.length > 0 ? providers : [], // Empty is OK now
      repositories: [repositoryFullName],
      supervisorEnabled: true,
      maxAgents: 10,
    });

    if (result.status === 'error') {
      return res.status(500).json({
        error: 'Failed to provision workspace',
        details: result.error,
      });
    }

    res.status(201).json({
      workspaceId: result.workspaceId,
      status: result.status,
      publicUrl: result.publicUrl,
      providersConnected: providers.length > 0,
      message: providers.length > 0
        ? 'Workspace provisioned successfully!'
        : 'Workspace provisioned! Connect an AI provider to start using agents.',
    });
  } catch (error) {
    console.error('Error quick provisioning:', error);
    res.status(500).json({ error: 'Failed to provision workspace' });
  }
});
