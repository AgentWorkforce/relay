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

  // GitHub OAuth
  github: {
    clientId: string;
    clientSecret: string;
    appId?: string;
    appPrivateKey?: string;
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
    };
    railway?: {
      apiToken: string;
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
      appId: optionalEnv('GITHUB_APP_ID'),
      appPrivateKey: optionalEnv('GITHUB_APP_PRIVATE_KEY'),
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
          }
        : undefined,
      railway: optionalEnv('RAILWAY_API_TOKEN')
        ? {
            apiToken: optionalEnv('RAILWAY_API_TOKEN')!,
          }
        : undefined,
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
