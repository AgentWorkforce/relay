import { homedir } from 'node:os';
import path from 'node:path';

import type { AgentRuntime } from './protocol.js';

export type HarnessRuntime = Extract<AgentRuntime, 'pty' | 'headless'>;
export type HarnessReleasePolicy = 'abort' | 'detach' | 'delete';
export type HeadlessHarnessDriver = 'app_server';

export interface PtyHarnessDelivery {
  mode?: 'pty-injection';
  format?: 'relay-block';
}

export interface PtyHarnessConfig {
  runtime: 'pty';
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  sessionId?: string;
  delivery?: PtyHarnessDelivery;
  metadata?: Record<string, unknown>;
}

export interface AppServerHarnessAuth {
  type: 'bearer' | 'basic' | 'none';
  token?: string;
  username?: string;
  password?: string;
}

export interface AppServerHarnessHost {
  /**
   * `broker-owned` is reserved for a future broker-supervised app-server mode.
   * Current broker releases accept attached hosts only.
   */
  ownership?: 'broker-owned' | 'attached';
  /** Local app-server host PID to report as the harness PID when known. */
  pid?: number;
}

export interface HeadlessAppServerHarnessConfig {
  runtime: 'headless';
  driver?: HeadlessHarnessDriver;
  protocol: 'opencode' | string;
  endpoint: string;
  sessionId: string;
  auth?: AppServerHarnessAuth;
  host?: AppServerHarnessHost;
  release?: HarnessReleasePolicy;
  metadata?: Record<string, unknown>;
}

export type ResolvedHarnessConfig = PtyHarnessConfig | HeadlessAppServerHarnessConfig;

export interface StaticPtyHarnessDefinition {
  runtime: 'pty';
  command: string;
  args?: string[];
  modelArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
  sessionId?: string;
  delivery?: PtyHarnessDelivery;
  metadata?: Record<string, unknown>;
}

export interface StaticHeadlessAppServerHarnessDefinition {
  runtime: 'headless';
  driver?: HeadlessHarnessDriver;
  protocol: 'opencode' | string;
  endpoint: string;
  sessionId: string;
  auth?: AppServerHarnessAuth;
  host?: AppServerHarnessHost;
  release?: HarnessReleasePolicy;
  metadata?: Record<string, unknown>;
}

export type StaticHarnessDefinition = StaticPtyHarnessDefinition | StaticHeadlessAppServerHarnessDefinition;
export type HarnessDefinition = StaticHarnessDefinition;

export interface ResolveStaticHarnessInput {
  name: string;
  cli: string;
  definition: StaticHarnessDefinition;
  args?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
}

const DEFAULT_PTY_ARGS = ['{args}'] as const;
const DEFAULT_MODEL_ARGS = ['--model', '{model}'] as const;

export function resolveStaticHarnessConfig(input: ResolveStaticHarnessInput): ResolvedHarnessConfig {
  const { definition } = input;
  if (definition.runtime === 'headless') {
    return {
      runtime: 'headless',
      driver: definition.driver ?? 'app_server',
      protocol: definition.protocol,
      endpoint: definition.endpoint,
      sessionId: definition.sessionId,
      ...(definition.auth ? { auth: { ...definition.auth } } : {}),
      ...(definition.host ? { host: { ...definition.host } } : {}),
      ...(definition.release ? { release: definition.release } : {}),
      ...(definition.metadata ? { metadata: { ...definition.metadata } } : {}),
    };
  }

  const context = {
    args: input.args ?? [],
    task: input.task,
    model: input.model,
    modelArgs: input.model
      ? renderTemplate(definition.modelArgs ?? DEFAULT_MODEL_ARGS, {
          args: [],
          task: input.task,
          model: input.model,
          modelArgs: [],
        })
      : [],
  };

  const configEnv = {
    ...(definition.env ?? {}),
    ...(input.env ?? {}),
  };

  return {
    runtime: 'pty',
    command: expandHome(definition.command),
    args: renderTemplate(definition.args ?? DEFAULT_PTY_ARGS, context),
    ...((input.cwd ?? definition.cwd) ? { cwd: input.cwd ?? definition.cwd } : {}),
    ...(Object.keys(configEnv).length > 0 ? { env: configEnv } : {}),
    ...(definition.sessionId ? { sessionId: definition.sessionId } : {}),
    ...(definition.delivery ? { delivery: { ...definition.delivery } } : {}),
    ...(definition.metadata ? { metadata: { ...definition.metadata } } : {}),
  };
}

export function harnessLookupKeys(cli: string): string[] {
  const trimmed = cli.trim();
  if (!trimmed) return [];
  const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
  const withoutModel = firstToken.split(':')[0] ?? firstToken;
  return Array.from(new Set([trimmed, firstToken, withoutModel].filter(Boolean)));
}

function renderTemplate(
  template: readonly string[],
  context: {
    args: string[];
    modelArgs: string[];
    task?: string;
    model?: string;
  }
): string[] {
  const rendered: string[] = [];
  for (const entry of template) {
    if (isExactPlaceholder(entry, 'args')) {
      rendered.push(...context.args);
      continue;
    }
    if (isExactPlaceholder(entry, 'modelArgs')) {
      rendered.push(...context.modelArgs);
      continue;
    }
    if (isExactPlaceholder(entry, 'task')) {
      if (context.task) rendered.push(context.task);
      continue;
    }
    if (isExactPlaceholder(entry, 'model')) {
      if (context.model) rendered.push(context.model);
      continue;
    }

    const value = entry
      .replace(/\{\{\s*task\s*\}\}|\{task\}/g, context.task ?? '')
      .replace(/\{\{\s*model\s*\}\}|\{model\}/g, context.model ?? '');
    if (value !== '') {
      rendered.push(value);
    }
  }
  return rendered;
}

function isExactPlaceholder(value: string, name: string): boolean {
  return value === `{${name}}` || value === `{{${name}}}`;
}

function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}
