import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const withId = (schema: unknown, id: string) =>
  Object.assign(schema as Record<string, unknown>, { $id: id });

// Relay connection defaults (used by daemon + wrapper)
export const ConnectionConfigSchema = z.object({
  maxFrameBytes: z.number().int().positive(),
  heartbeatMs: z.number().int().positive(),
  heartbeatTimeoutMultiplier: z.number().int().positive(),
  maxWriteQueueSize: z.number().int().nonnegative(),
  writeQueueHighWaterMark: z.number().int().nonnegative(),
  writeQueueLowWaterMark: z.number().int().nonnegative(),
});

export const TmuxWrapperConfigSchema = z.object({
  pollInterval: z.number().int().positive(),
  idleBeforeInjectMs: z.number().int().nonnegative(),
  injectRetryMs: z.number().int().nonnegative(),
  debug: z.boolean(),
  debugLogIntervalMs: z.number().int().nonnegative(),
  mouseMode: z.boolean(),
  activityIdleThresholdMs: z.number().int().nonnegative(),
  outputStabilityTimeoutMs: z.number().int().nonnegative(),
  outputStabilityPollMs: z.number().int().nonnegative(),
  streamLogs: z.boolean(),
});

export const RelayRuntimeConfigSchema = z.object({
  trajectories: z
    .object({
      storeInRepo: z.boolean().optional(),
    })
    .optional(),
});

export const BridgeConfigSchema = z.object({
  projects: z
    .record(
      z.object({
        lead: z.string().optional(),
        cli: z.string().optional(),
      })
    )
    .optional(),
  defaultCli: z.string().optional(),
});

export const TeamsConfigSchema = z.object({
  team: z.string(),
  agents: z
    .array(
      z.object({
        name: z.string(),
        cli: z.string(),
        role: z.string().optional(),
        task: z.string().optional(),
      })
    )
    .default([]),
  autoSpawn: z.boolean().optional(),
});

export const ShadowRoleConfigSchema = z.object({
  prompt: z.string().optional(),
  speakOn: z.array(z.string()).default([]),
});

export const ShadowPairConfigSchema = z.object({
  shadow: z.string(),
  shadowRole: z.string().optional(),
  speakOn: z.array(z.string()).optional(),
});

export const ShadowConfigSchema = z.object({
  shadows: z
    .object({
      pairs: z.record(ShadowPairConfigSchema).optional(),
      roles: z.record(ShadowRoleConfigSchema).optional(),
    })
    .optional(),
});

export const AgentFrontmatterSchema = z.object({
  name: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  agentType: z.string().optional(),
  role: z.string().optional(),
  'allowed-tools': z.string().optional(),
});

export const CLIAuthConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  deviceFlowArgs: z.array(z.string()).optional(),
  urlPattern: z.instanceof(RegExp),
  credentialPath: z.string().optional(),
  displayName: z.string(),
  prompts: z
    .array(
      z.object({
        pattern: z.instanceof(RegExp),
        response: z.string(),
        delay: z.number().int().nonnegative().optional(),
        description: z.string(),
      })
    )
    .default([]),
  successPatterns: z.array(z.instanceof(RegExp)).default([]),
  errorPatterns: z
    .array(
      z.object({
        pattern: z.instanceof(RegExp),
        message: z.string(),
        recoverable: z.boolean(),
        hint: z.string().optional(),
      })
    )
    .optional(),
  waitTimeout: z.number().int().nonnegative(),
  supportsDeviceFlow: z.boolean().optional(),
});

export const CloudConfigSchema = z.object({
  port: z.number().int(),
  publicUrl: z.string(),
  appUrl: z.string(),
  sessionSecret: z.string(),
  localDashboardUrl: z.string().optional(),
  databaseUrl: z.string(),
  redisUrl: z.string(),
  github: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    webhookSecret: z.string().optional(),
  }),
  providers: z
    .object({
      anthropic: z.object({ clientId: z.string() }).optional(),
      openai: z.object({ clientId: z.string() }).optional(),
      google: z
        .object({
          clientId: z.string(),
          clientSecret: z.string(),
        })
        .optional(),
    })
    .default({}),
  vault: z.object({
    masterKey: z.string(),
  }),
  compute: z.object({
    provider: z.enum(['fly', 'railway', 'docker']),
    fly: z
      .object({
        apiToken: z.string(),
        org: z.string(),
        region: z.string().optional(),
        workspaceDomain: z.string().optional(),
        registryAuth: z
          .object({
            username: z.string(),
            password: z.string(),
          })
          .optional(),
        snapshotRetentionDays: z.number().int().optional(),
        volumeSizeGb: z.number().int().optional(),
      })
      .optional(),
    railway: z
      .object({
        apiToken: z.string(),
      })
      .optional(),
  }),
  nango: z.object({
    secretKey: z.string(),
    host: z.string().optional(),
  }),
  stripe: z.object({
    secretKey: z.string(),
    publishableKey: z.string(),
    webhookSecret: z.string(),
    priceIds: z.record(z.string().optional()),
  }),
  adminUsers: z.array(z.string()),
});

export const jsonSchemas = {
  connection: withId(zodToJsonSchema(ConnectionConfigSchema, { target: 'jsonSchema7' }), 'RelayConnectionConfig'),
  tmuxWrapper: withId(zodToJsonSchema(TmuxWrapperConfigSchema, { target: 'jsonSchema7' }), 'RelayTmuxWrapperConfig'),
  relayRuntime: withId(zodToJsonSchema(RelayRuntimeConfigSchema, { target: 'jsonSchema7' }), 'RelayRuntimeConfig'),
  bridge: withId(zodToJsonSchema(BridgeConfigSchema, { target: 'jsonSchema7' }), 'BridgeConfig'),
  teams: withId(zodToJsonSchema(TeamsConfigSchema, { target: 'jsonSchema7' }), 'TeamsConfig'),
  shadow: withId(zodToJsonSchema(ShadowConfigSchema, { target: 'jsonSchema7' }), 'ShadowConfig'),
  agentFrontmatter: withId(zodToJsonSchema(AgentFrontmatterSchema, { target: 'jsonSchema7' }), 'AgentFrontmatter'),
  cliAuth: withId(zodToJsonSchema(CLIAuthConfigSchema, { target: 'jsonSchema7' }), 'CLIAuthConfig'),
  cloud: withId(zodToJsonSchema(CloudConfigSchema, { target: 'jsonSchema7' }), 'CloudConfig'),
};
