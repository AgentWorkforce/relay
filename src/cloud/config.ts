/**
 * Agent Relay Cloud - Configuration
 */

export interface CloudConfig {
  // Server
  port: number;
  publicUrl: string;
  sessionSecret: string;

  // Database
  databaseUrl: string;
  redisUrl: string;

  // GitHub OAuth & App
  github: {
    clientId: string;
    clientSecret: string;
    appId: string;
    appPrivateKey: string;
    appWebhookSecret: string;
    appClientId?: string;
    appClientSecret?: string;
  };

  // Provider OAuth (for device flow)
  // Note: Only Google has public OAuth today. Claude/Codex use CLI-based auth.
  providers: {
    // Anthropic: Future OAuth support (hypothetical - requires Anthropic to implement)
    anthropic?: { clientId: string };
    // OpenAI: Future OAuth support (hypothetical - requires OpenAI to implement)
    openai?: { clientId: string };
    // Google: Has real OAuth device flow support
    google?: { clientId: string; clientSecret: string };
  };

  // Credential vault
  vault: {
    masterKey: string; // 32 bytes, base64 encoded
  };

  // Compute provisioner
  compute: {
    provider: 'fly' | 'railway' | 'docker';
    fly?: {
      apiToken: string;
      org: string;
      region?: string;
      workspaceDomain?: string; // e.g., ws.agent-relay.com
    };
    railway?: {
      apiToken: string;
    };
  };

  // Nango OAuth management
  nango: {
    secretKey: string;
    host?: string;
  };

  // Stripe billing
  stripe: {
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
    priceIds: {
      proMonthly?: string;
      proYearly?: string;
      teamMonthly?: string;
      teamYearly?: string;
      enterpriseMonthly?: string;
      enterpriseYearly?: string;
    };
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

export function loadConfig(): CloudConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
    sessionSecret: requireEnv('SESSION_SECRET'),

    databaseUrl: requireEnv('DATABASE_URL'),
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

    github: {
      clientId: requireEnv('GITHUB_CLIENT_ID'),
      clientSecret: requireEnv('GITHUB_CLIENT_SECRET'),
      appId: requireEnv('GITHUB_APP_ID'),
      appPrivateKey: requireEnv('GITHUB_APP_PRIVATE_KEY'),
      appWebhookSecret: requireEnv('GITHUB_APP_WEBHOOK_SECRET'),
      appClientId: optionalEnv('GITHUB_APP_CLIENT_ID'),
      appClientSecret: optionalEnv('GITHUB_APP_CLIENT_SECRET'),
    },

    providers: {
      anthropic: optionalEnv('ANTHROPIC_CLIENT_ID')
        ? { clientId: optionalEnv('ANTHROPIC_CLIENT_ID')! }
        : undefined,
      openai: optionalEnv('OPENAI_CLIENT_ID')
        ? { clientId: optionalEnv('OPENAI_CLIENT_ID')! }
        : undefined,
      google:
        optionalEnv('GOOGLE_CLIENT_ID') && optionalEnv('GOOGLE_CLIENT_SECRET')
          ? {
              clientId: optionalEnv('GOOGLE_CLIENT_ID')!,
              clientSecret: optionalEnv('GOOGLE_CLIENT_SECRET')!,
            }
          : undefined,
    },

    vault: {
      masterKey: requireEnv('VAULT_MASTER_KEY'),
    },

    compute: {
      provider: (process.env.COMPUTE_PROVIDER as 'fly' | 'railway' | 'docker') || 'docker',
      fly: optionalEnv('FLY_API_TOKEN')
        ? {
            apiToken: optionalEnv('FLY_API_TOKEN')!,
            org: optionalEnv('FLY_ORG') || 'personal',
            region: optionalEnv('FLY_REGION') || 'sjc',
            workspaceDomain: optionalEnv('FLY_WORKSPACE_DOMAIN'),
          }
        : undefined,
      railway: optionalEnv('RAILWAY_API_TOKEN')
        ? {
            apiToken: optionalEnv('RAILWAY_API_TOKEN')!,
          }
        : undefined,
    },

    nango: {
      secretKey: requireEnv('NANGO_SECRET_KEY'),
      host: optionalEnv('NANGO_HOST'),
    },

    stripe: {
      secretKey: requireEnv('STRIPE_SECRET_KEY'),
      publishableKey: requireEnv('STRIPE_PUBLISHABLE_KEY'),
      webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
      priceIds: {
        proMonthly: optionalEnv('STRIPE_PRO_MONTHLY_PRICE_ID'),
        proYearly: optionalEnv('STRIPE_PRO_YEARLY_PRICE_ID'),
        teamMonthly: optionalEnv('STRIPE_TEAM_MONTHLY_PRICE_ID'),
        teamYearly: optionalEnv('STRIPE_TEAM_YEARLY_PRICE_ID'),
        enterpriseMonthly: optionalEnv('STRIPE_ENTERPRISE_MONTHLY_PRICE_ID'),
        enterpriseYearly: optionalEnv('STRIPE_ENTERPRISE_YEARLY_PRICE_ID'),
      },
    },
  };
}

// Singleton config instance
let _config: CloudConfig | null = null;

export function getConfig(): CloudConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
