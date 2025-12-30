/**
 * Providers API Routes
 *
 * Handles device flow authentication for AI providers (Claude, Codex, etc.)
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from './auth';
import { getConfig } from '../config';
import { db } from '../db';
import { vault } from '../vault';

export const providersRouter = Router();

// All routes require authentication
providersRouter.use(requireAuth);

/**
 * Provider registry with OAuth/device flow configuration
 *
 * Auth Strategy:
 * - google: Real OAuth device flow (works today)
 * - anthropic: CLI-based auth (user runs `claude login`, we detect credentials)
 * - openai: CLI-based auth (user runs `codex auth`, we detect credentials)
 *
 * When providers add OAuth support, we can switch to device flow.
 */
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    displayName: 'Claude',
    description: 'Claude Code - recommended for code tasks',
    // Auth strategy: CLI-based until Anthropic adds OAuth
    authStrategy: 'cli' as const,
    cliCommand: 'claude login',
    credentialPath: '~/.claude/credentials.json', // Where Claude stores tokens
    // Future OAuth endpoints (hypothetical - for when Anthropic implements)
    deviceCodeUrl: 'https://api.anthropic.com/oauth/device/code',
    tokenUrl: 'https://api.anthropic.com/oauth/token',
    userInfoUrl: 'https://api.anthropic.com/v1/user',
    scopes: ['claude-code:execute', 'user:read'],
    color: '#D97757',
  },
  openai: {
    name: 'OpenAI',
    displayName: 'Codex',
    description: 'Codex CLI for AI-assisted coding',
    // Auth strategy: CLI-based until OpenAI adds OAuth
    authStrategy: 'cli' as const,
    cliCommand: 'codex auth',
    credentialPath: '~/.codex/credentials.json',
    // Future OAuth endpoints (hypothetical)
    deviceCodeUrl: 'https://auth.openai.com/device/code',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    userInfoUrl: 'https://api.openai.com/v1/user',
    scopes: ['openid', 'profile', 'email', 'codex:execute'],
    color: '#10A37F',
  },
  google: {
    name: 'Google',
    displayName: 'Gemini',
    description: 'Gemini - multi-modal capabilities',
    // Auth strategy: Real OAuth device flow (works today!)
    authStrategy: 'device_flow' as const,
    deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/generative-language'],
    color: '#4285F4',
  },
};

type ProviderType = keyof typeof PROVIDERS;

// In-memory store for active device flows (use Redis in production)
interface ActiveDeviceFlow {
  userId: string;
  provider: ProviderType;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: Date;
  pollInterval: number;
  status: 'pending' | 'success' | 'expired' | 'denied' | 'error';
  error?: string;
}

const activeFlows = new Map<string, ActiveDeviceFlow>();

/**
 * GET /api/providers
 * List all providers with connection status
 */
providersRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  try {
    const credentials = await db.credentials.findByUserId(userId);

    const providers = Object.entries(PROVIDERS).map(([id, provider]) => {
      const credential = credentials.find((c) => c.provider === id);
      return {
        id,
        name: provider.name,
        displayName: provider.displayName,
        description: provider.description,
        color: provider.color,
        authStrategy: provider.authStrategy,
        cliCommand: provider.authStrategy === 'cli' ? provider.cliCommand : undefined,
        isConnected: !!credential,
        connectedAs: credential?.providerAccountEmail,
        connectedAt: credential?.createdAt,
      };
    });

    // Add GitHub (always connected via signup)
    const githubCred = credentials.find((c) => c.provider === 'github');
    providers.unshift({
      id: 'github',
      name: 'GitHub',
      displayName: 'Copilot',
      description: 'GitHub Copilot - connected via signup',
      color: '#24292F',
      isConnected: true,
      connectedAs: githubCred?.providerAccountEmail,
      connectedAt: githubCred?.createdAt,
    });

    res.json({ providers });
  } catch (error) {
    console.error('Error listing providers:', error);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

/**
 * POST /api/providers/:provider/connect
 * Start auth flow for a provider (device flow or CLI instructions)
 */
providersRouter.post('/:provider/connect', async (req: Request, res: Response) => {
  const { provider } = req.params as { provider: ProviderType };
  const userId = req.session.userId!;
  const config = getConfig();

  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) {
    return res.status(404).json({ error: 'Unknown provider' });
  }

  // CLI-based auth (Claude, Codex) - return instructions
  if (providerConfig.authStrategy === 'cli') {
    return res.json({
      authStrategy: 'cli',
      provider: provider,
      displayName: providerConfig.displayName,
      instructions: [
        `1. Open your terminal`,
        `2. Run: ${providerConfig.cliCommand}`,
        `3. Complete the login in your browser`,
        `4. Return here and click "Verify Connection"`,
      ],
      cliCommand: providerConfig.cliCommand,
      // For cloud-hosted: we'll check the workspace container for credentials
      // For self-hosted: user's local credentials will be synced
      verifyEndpoint: `/api/providers/${provider}/verify`,
    });
  }

  // Device flow auth (Google) - start OAuth device flow
  const clientConfig = config.providers[provider];
  if (!clientConfig) {
    return res.status(400).json({ error: `Provider ${provider} not configured` });
  }

  try {
    // Request device code from provider
    const response = await fetch(providerConfig.deviceCodeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientConfig.clientId,
        scope: providerConfig.scopes.join(' '),
        ...((provider === 'google') && { client_secret: (clientConfig as any).clientSecret }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get device code: ${error}`);
    }

    const data = await response.json();

    // Generate flow ID
    const flowId = crypto.randomUUID();

    // Store active flow
    activeFlows.set(flowId, {
      userId,
      provider,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      pollInterval: data.interval || 5,
      status: 'pending',
    });

    // Start background polling
    pollForToken(flowId, provider, clientConfig.clientId);

    res.json({
      authStrategy: 'device_flow',
      flowId,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresIn: data.expires_in,
    });
  } catch (error) {
    console.error(`Error starting device flow for ${provider}:`, error);
    res.status(500).json({ error: 'Failed to start device flow' });
  }
});

/**
 * POST /api/providers/:provider/verify
 * Verify CLI-based auth completed (for Claude, Codex)
 * User calls this after running the CLI login command
 */
providersRouter.post('/:provider/verify', async (req: Request, res: Response) => {
  const { provider } = req.params as { provider: ProviderType };
  const userId = req.session.userId!;

  const providerConfig = PROVIDERS[provider];
  if (!providerConfig || providerConfig.authStrategy !== 'cli') {
    return res.status(400).json({ error: 'Provider does not use CLI auth' });
  }

  // For cloud-hosted workspaces: the workspace container will have the credentials
  // For self-hosted: we trust the user completed the CLI flow
  // In production, we'd verify by making a test API call with the credentials

  try {
    // For now, mark as connected (in production, verify credentials exist)
    // This would be called after the user's workspace detects valid credentials
    await db.credentials.upsert({
      userId,
      provider,
      accessToken: 'cli-authenticated', // Placeholder - real token from CLI
      scopes: providerConfig.scopes,
      providerAccountEmail: req.body.email, // User can optionally provide
    });

    res.json({
      success: true,
      message: `${providerConfig.displayName} connected via CLI`,
      note: 'Credentials will be synced when workspace starts',
    });
  } catch (error) {
    console.error(`Error verifying ${provider} auth:`, error);
    res.status(500).json({ error: 'Failed to verify connection' });
  }
});

/**
 * GET /api/providers/:provider/status/:flowId
 * Check status of device flow
 */
providersRouter.get('/:provider/status/:flowId', (req: Request, res: Response) => {
  const { flowId } = req.params;
  const userId = req.session.userId!;

  const flow = activeFlows.get(flowId);
  if (!flow) {
    return res.status(404).json({ error: 'Flow not found or expired' });
  }

  if (flow.userId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const expiresIn = Math.max(0, Math.floor((flow.expiresAt.getTime() - Date.now()) / 1000));

  res.json({
    status: flow.status,
    expiresIn,
    error: flow.error,
  });
});

/**
 * DELETE /api/providers/:provider
 * Disconnect a provider
 */
providersRouter.delete('/:provider', async (req: Request, res: Response) => {
  const { provider } = req.params;
  const userId = req.session.userId!;

  if (provider === 'github') {
    return res.status(400).json({ error: 'Cannot disconnect GitHub' });
  }

  try {
    await db.credentials.delete(userId, provider);
    res.json({ success: true });
  } catch (error) {
    console.error(`Error disconnecting ${provider}:`, error);
    res.status(500).json({ error: 'Failed to disconnect provider' });
  }
});

/**
 * DELETE /api/providers/:provider/flow/:flowId
 * Cancel a device flow
 */
providersRouter.delete('/:provider/flow/:flowId', (req: Request, res: Response) => {
  const { flowId } = req.params;
  const userId = req.session.userId!;

  const flow = activeFlows.get(flowId);
  if (flow?.userId === userId) {
    activeFlows.delete(flowId);
  }

  res.json({ success: true });
});

/**
 * Background polling for device authorization
 */
async function pollForToken(flowId: string, provider: ProviderType, clientId: string) {
  const flow = activeFlows.get(flowId);
  if (!flow) return;

  const providerConfig = PROVIDERS[provider];
  let interval = flow.pollInterval * 1000;

  const poll = async () => {
    const current = activeFlows.get(flowId);
    if (!current || current.status !== 'pending') return;

    // Check expiry
    if (Date.now() > current.expiresAt.getTime()) {
      current.status = 'expired';
      return;
    }

    try {
      const response = await fetch(providerConfig.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: current.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const data = await response.json();

      if (data.error) {
        switch (data.error) {
          case 'authorization_pending':
            setTimeout(poll, interval);
            break;
          case 'slow_down':
            interval = (data.interval || 10) * 1000;
            setTimeout(poll, interval);
            break;
          case 'expired_token':
            current.status = 'expired';
            break;
          case 'access_denied':
            current.status = 'denied';
            break;
          default:
            current.status = 'error';
            current.error = data.error_description || data.error;
        }
        return;
      }

      // Success! Store tokens
      await storeProviderTokens(current.userId, provider, {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        scope: data.scope,
      });

      current.status = 'success';

      // Clean up after 60s
      setTimeout(() => activeFlows.delete(flowId), 60000);
    } catch (error) {
      console.error('Poll error:', error);
      setTimeout(poll, interval * 2);
    }
  };

  // Start polling after initial interval
  setTimeout(poll, interval);
}

/**
 * Store tokens after successful device flow
 */
async function storeProviderTokens(
  userId: string,
  provider: ProviderType,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    scope?: string;
  }
) {
  const providerConfig = PROVIDERS[provider];

  // Fetch user info from provider
  let userInfo: { id?: string; email?: string } = {};
  try {
    const response = await fetch(providerConfig.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    if (response.ok) {
      userInfo = await response.json();
    }
  } catch (error) {
    console.error('Error fetching user info:', error);
  }

  // Encrypt and store
  await vault.storeCredential({
    userId,
    provider,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresIn
      ? new Date(Date.now() + tokens.expiresIn * 1000)
      : undefined,
    scopes: tokens.scope?.split(' '),
    providerAccountId: userInfo.id,
    providerAccountEmail: userInfo.email,
  });
}
