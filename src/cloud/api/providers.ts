/**
 * Providers API Routes
 *
 * Handles device flow authentication for AI providers (Claude, Codex, etc.)
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createClient } from 'redis';
import { requireAuth } from './auth.js';
import { getConfig } from '../config.js';
import { db } from '../db/index.js';
import { vault } from '../vault/index.js';

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
// Base provider properties
interface BaseProvider {
  name: string;
  displayName: string;
  description: string;
  color: string;
}

// CLI-based auth provider (Claude, OpenCode, Droid)
interface CliProvider extends BaseProvider {
  authStrategy: 'cli';
  cliCommand: string;
  credentialPath: string;
}

// Device flow OAuth provider (Google)
interface DeviceFlowProvider extends BaseProvider {
  authStrategy: 'device_flow';
  deviceCodeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
}

type Provider = CliProvider | DeviceFlowProvider;

const PROVIDERS: Record<string, Provider> = {
  anthropic: {
    name: 'Anthropic',
    displayName: 'Claude',
    description: 'Claude Code - recommended for code tasks',
    authStrategy: 'cli',
    cliCommand: 'claude',
    credentialPath: '~/.claude/credentials.json',
    color: '#D97757',
  },
  codex: {
    name: 'OpenAI',
    displayName: 'Codex',
    description: 'Codex - OpenAI coding assistant',
    authStrategy: 'cli',
    cliCommand: 'codex login',
    credentialPath: '~/.codex/credentials.json',
    color: '#10A37F',
  },
  opencode: {
    name: 'OpenCode',
    displayName: 'OpenCode',
    description: 'OpenCode - AI coding assistant',
    authStrategy: 'cli',
    cliCommand: 'opencode',
    credentialPath: '~/.opencode/credentials.json',
    color: '#00D4AA',
  },
  droid: {
    name: 'Factory',
    displayName: 'Droid',
    description: 'Droid - Factory AI coding agent',
    authStrategy: 'cli',
    cliCommand: 'droid',
    credentialPath: '~/.factory/credentials.json',
    color: '#6366F1',
  },
  google: {
    name: 'Google',
    displayName: 'Gemini',
    description: 'Gemini - multi-modal capabilities',
    authStrategy: 'device_flow',
    deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/generative-language'],
    color: '#4285F4',
  },
};

// Type guard for device flow providers
function isDeviceFlowProvider(provider: Provider): provider is DeviceFlowProvider {
  return provider.authStrategy === 'device_flow';
}

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

// Redis v4 client type
type RedisClientType = ReturnType<typeof createClient>;
let redisClient: RedisClientType | null = null;

async function getRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    const config = getConfig();
    redisClient = createClient({ url: config.redisUrl });
    redisClient.on('error', (err: Error) => console.error('[redis] provider flow error', err));
    await (redisClient as any).connect();
  }
  return redisClient;
}

const flowKey = (flowId: string) => `provider-flow:${flowId}`;

async function saveFlow(flowId: string, flow: ActiveDeviceFlow): Promise<void> {
  const client = await getRedisClient() as any;
  const ttlSeconds = Math.max(60, Math.ceil((flow.expiresAt.getTime() - Date.now()) / 1000));
  await client.setEx(flowKey(flowId), ttlSeconds, JSON.stringify(flow));
}

async function loadFlow(flowId: string): Promise<ActiveDeviceFlow | null> {
  const client = await getRedisClient() as any;
  const raw: string | null = await client.get(flowKey(flowId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as ActiveDeviceFlow;
  parsed.expiresAt = new Date(parsed.expiresAt);
  return parsed;
}

async function deleteFlow(flowId: string): Promise<void> {
  const client = await getRedisClient() as any;
  await client.del(flowKey(flowId));
}

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
      authStrategy: 'device_flow' as const,
      cliCommand: undefined,
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
  // At this point, we know it's a device flow provider (CLI was handled above)
  if (!isDeviceFlowProvider(providerConfig)) {
    return res.status(400).json({ error: 'Provider does not support device flow' });
  }

  // Only google is configured for device flow in config
  const clientConfig = provider === 'google' ? config.providers.google : undefined;
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
        ...((provider === 'google') && { client_secret: clientConfig.clientSecret }),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get device code: ${error}`);
    }

    const data = await response.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete?: string;
      expires_in: number;
      interval?: number;
    };

    // Generate flow ID
    const flowId = crypto.randomUUID();

    const flow: ActiveDeviceFlow = {
      userId,
      provider,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      pollInterval: data.interval || 5,
      status: 'pending',
    };

    await saveFlow(flowId, flow);

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
      scopes: [], // CLI auth doesn't use scopes
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
 * POST /api/providers/:provider/api-key
 * Connect a provider using an API key (for cloud-hosted workspaces)
 */
providersRouter.post('/:provider/api-key', async (req: Request, res: Response) => {
  const { provider } = req.params as { provider: ProviderType };
  const userId = req.session.userId!;
  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'API key is required' });
  }

  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) {
    return res.status(404).json({ error: 'Unknown provider' });
  }

  // Validate the API key by making a test request
  try {
    let isValid = false;

    if (provider === 'anthropic') {
      // Test Anthropic API key
      const testRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      // 200 = valid, 401 = invalid key, 400/other = might still be valid key
      isValid = testRes.status !== 401;
    } else {
      // For other providers, just accept the key
      isValid = true;
    }

    if (!isValid) {
      return res.status(400).json({ error: 'Invalid API key' });
    }

    // Store the API key - use scopes from device flow providers, empty for CLI providers
    const scopes = isDeviceFlowProvider(providerConfig) ? providerConfig.scopes : [];
    await vault.storeCredential({
      userId,
      provider,
      accessToken: apiKey,
      scopes,
    });

    res.json({
      success: true,
      message: `${providerConfig.displayName} connected`,
    });
  } catch (error) {
    console.error(`Error connecting ${provider} with API key:`, error);
    res.status(500).json({ error: 'Failed to connect provider' });
  }
});

/**
 * GET /api/providers/:provider/status/:flowId
 * Check status of device flow
 */
providersRouter.get('/:provider/status/:flowId', (req: Request, res: Response) => {
  const { flowId } = req.params;
  const userId = req.session.userId!;

  loadFlow(flowId)
    .then((flow) => {
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
    })
    .catch((error) => {
      console.error('Error checking flow status:', error);
      res.status(500).json({ error: 'Failed to check flow status' });
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

  loadFlow(flowId)
    .then(async (flow) => {
      if (flow?.userId === userId) {
        await deleteFlow(flowId);
      }
      res.json({ success: true });
    })
    .catch((error) => {
      console.error('Error deleting flow:', error);
      res.status(500).json({ error: 'Failed to cancel flow' });
    });
});

/**
 * Background polling for device authorization
 */
async function pollForToken(flowId: string, provider: ProviderType, clientId: string) {
  const providerConfig = PROVIDERS[provider];

  // Only device flow providers can poll for tokens
  if (!isDeviceFlowProvider(providerConfig)) {
    console.error(`Provider ${provider} does not support device flow polling`);
    return;
  }

  const poll = async (intervalMs: number) => {
    const current = await loadFlow(flowId);
    if (!current || current.status !== 'pending') return;

    if (Date.now() > current.expiresAt.getTime()) {
      current.status = 'expired';
      await saveFlow(flowId, current);
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

      const data = await response.json() as {
        error?: string;
        error_description?: string;
        interval?: number;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };

      if (data.error) {
        switch (data.error) {
          case 'authorization_pending':
            return setTimeout(() => poll(intervalMs), intervalMs).unref();
          case 'slow_down': {
            const nextInterval = (data.interval || intervalMs / 1000 || 5) * 1000;
            return setTimeout(() => poll(nextInterval), nextInterval).unref();
          }
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
        await saveFlow(flowId, current);
        return;
      }

      // Success! Store tokens
      await storeProviderTokens(current.userId, provider, {
        accessToken: data.access_token!,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        scope: data.scope,
      });

      current.status = 'success';
      await saveFlow(flowId, current);
      setTimeout(() => {
        deleteFlow(flowId).catch((err) => console.error('Error cleaning up flow', err));
      }, 60000).unref();
    } catch (error) {
      console.error('Poll error:', error);
      const nextInterval = intervalMs * 2;
      setTimeout(() => poll(nextInterval), nextInterval).unref();
    }
  };

  loadFlow(flowId)
    .then((flow) => {
      const initialInterval = (flow?.pollInterval ?? 5) * 1000;
      setTimeout(() => poll(initialInterval), initialInterval).unref();
    })
    .catch((err) => console.error('Poll start error:', err));
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

  // Fetch user info from provider (only device flow providers have userInfoUrl)
  let userInfo: { id?: string; email?: string } = {};
  if (isDeviceFlowProvider(providerConfig)) {
    try {
      const response = await fetch(providerConfig.userInfoUrl, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      });
      if (response.ok) {
        userInfo = await response.json() as { id?: string; email?: string };
      }
    } catch (error) {
      console.error('Error fetching user info:', error);
    }
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
