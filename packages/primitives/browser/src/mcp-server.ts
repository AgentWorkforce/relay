#!/usr/bin/env node
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { BrowserClient } from './browser-client.js';
import type {
  ActionResult,
  BrowserActionName,
  BrowserActionRequest,
  BrowserConfig,
  BrowserSession,
} from './types.js';
import {
  BrowserStepExecutor,
  type BrowserStepConfig,
  type BrowserStepExecutionResult,
} from './workflow-step.js';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface BrowserMcpServerOptions {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  serverName?: string;
  serverVersion?: string;
  defaultConfig?: BrowserConfig;
}

export interface BrowserSessionCreateParams {
  config?: BrowserConfig;
}

export interface BrowserSessionTargetParams {
  sessionId: string;
}

export interface BrowserActionExecuteParams {
  sessionId?: string;
  action: BrowserActionName;
  params?: Record<string, unknown>;
  config?: BrowserConfig;
}

export interface BrowserActionsExecuteParams {
  sessionId?: string;
  actions: BrowserActionRequest[];
  config?: BrowserConfig;
}

export interface BrowserStepExecuteParams {
  step: BrowserStepConfig;
  workspaceId?: string;
}

export class BrowserMcpSessionManager {
  private readonly clients = new Map<string, BrowserClient>();
  private defaultSessionId?: string;

  constructor(private readonly defaultConfig: BrowserConfig = {}) {}

  async create(config: BrowserConfig = {}): Promise<BrowserSession> {
    const client = new BrowserClient({
      config: {
        ...this.defaultConfig,
        ...config,
      },
    });
    const session = await client.launch();

    this.clients.set(session.id, client);
    this.defaultSessionId ??= session.id;
    return session;
  }

  async getOrCreate(sessionId?: string, config: BrowserConfig = {}): Promise<BrowserClient> {
    if (sessionId) {
      const existing = this.clients.get(sessionId);
      if (existing) return existing;
      throw new Error(`Browser session not found: ${sessionId}`);
    }

    if (this.defaultSessionId) {
      const existing = this.clients.get(this.defaultSessionId);
      if (existing) return existing;
    }

    const session = await this.create(config);
    const client = this.clients.get(session.id);
    if (!client) {
      throw new Error(`Browser session was not registered: ${session.id}`);
    }
    return client;
  }

  get(sessionId: string): BrowserSession {
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    return client.getSession();
  }

  list(): BrowserSession[] {
    return [...this.clients.values()].map((client) => client.getSession());
  }

  async close(sessionId: string): Promise<{ closed: boolean; sessionId: string }> {
    const client = this.clients.get(sessionId);
    if (!client) {
      return { closed: false, sessionId };
    }

    await client.close();
    this.clients.delete(sessionId);
    if (this.defaultSessionId === sessionId) {
      this.defaultSessionId = this.clients.keys().next().value;
    }
    return { closed: true, sessionId };
  }

  async reset(sessionId: string, config?: BrowserConfig): Promise<BrowserSession> {
    const client = this.clients.get(sessionId);
    if (!client) {
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    return client.reset(config);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
    this.defaultSessionId = undefined;
  }
}

export class BrowserMcpServer {
  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly sessions: BrowserMcpSessionManager;
  private readonly stepExecutor: BrowserStepExecutor;
  private rl?: ReadlineInterface;

  constructor(options: BrowserMcpServerOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.serverName = options.serverName ?? 'agent-relay-browser';
    this.serverVersion = options.serverVersion ?? '1.0.0';
    this.sessions = new BrowserMcpSessionManager(options.defaultConfig);
    this.stepExecutor = new BrowserStepExecutor({ config: options.defaultConfig });
  }

  start(): void {
    this.rl = createInterface({ input: this.stdin, terminal: false });

    this.rl.on('line', (line) => {
      void this.handleLine(line);
    });
    this.rl.on('close', () => {
      void this.shutdown(0);
    });

    process.on('SIGTERM', () => {
      void this.shutdown(0);
    });
    process.on('SIGINT', () => {
      void this.shutdown(0);
    });

    this.stderr.write(`[${this.serverName}] MCP server started (stdio)\n`);
  }

  async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.writeResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const response = await this.handleRequest(request);
    if (response) {
      this.writeResponse(response);
    }
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const id = request.id ?? null;
    const isNotification = request.id === undefined;

    try {
      const result = await this.dispatch(request.method, request.params);
      if (isNotification) return undefined;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (isNotification) return undefined;
      return {
        jsonrpc: '2.0',
        id,
        error: toJsonRpcError(error),
      };
    }
  }

  async shutdown(exitCode?: number): Promise<void> {
    await this.sessions.closeAll();
    await this.stepExecutor.closeAll();
    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion,
          },
        };

      case 'notifications/initialized':
        return undefined;

      case 'tools/list':
        return { tools: getBrowserToolDefinitions() };

      case 'tools/call':
        return this.handleToolCall(params);

      case 'browser.session.create':
        return this.createSession(params);

      case 'browser.session.list':
        return this.sessions.list();

      case 'browser.session.get':
        return this.getSession(params);

      case 'browser.session.close':
        return this.closeSession(params);

      case 'browser.session.reset':
        return this.resetSession(params);

      case 'browser.action.execute':
        return this.executeAction(params);

      case 'browser.actions.execute':
        return this.executeActions(params);

      case 'browser.step.execute':
        return this.executeStep(params);

      default:
        throw jsonRpcMethodNotFound(method);
    }
  }

  private async handleToolCall(params: unknown): Promise<unknown> {
    const toolParams = requireRecord(params, 'tools/call params');
    const name = requireString(toolParams.name, 'tools/call params.name');
    const args = isRecord(toolParams.arguments) ? toolParams.arguments : {};

    switch (name) {
      case 'browser_session_create':
        return toMcpToolResult(await this.createSession(args));
      case 'browser_session_list':
        return toMcpToolResult(this.sessions.list());
      case 'browser_session_get':
        return toMcpToolResult(this.getSession(args));
      case 'browser_session_close':
        return toMcpToolResult(await this.closeSession(args));
      case 'browser_session_reset':
        return toMcpToolResult(await this.resetSession(args));
      case 'browser_action_execute': {
        const result = await this.executeAction(args);
        return toMcpToolResult(result, isActionError(result));
      }
      case 'browser_actions_execute': {
        const result = await this.executeActions(args);
        return toMcpToolResult(result, hasActionErrors(result));
      }
      case 'browser_step_execute': {
        const result = await this.executeStep(args);
        return toMcpToolResult(result, !(result as BrowserStepExecutionResult).success);
      }
      default:
        throw new Error(`Unknown browser tool: ${name}`);
    }
  }

  private async createSession(params: unknown): Promise<BrowserSession> {
    const record = params === undefined ? {} : requireRecord(params, 'browser.session.create params');
    return this.sessions.create(readOptionalRecord<BrowserConfig>(record.config, 'config') ?? {});
  }

  private getSession(params: unknown): BrowserSession {
    const record = requireRecord(params, 'browser.session.get params');
    return this.sessions.get(requireString(record.sessionId, 'sessionId'));
  }

  private async closeSession(params: unknown): Promise<{ closed: boolean; sessionId: string }> {
    const record = requireRecord(params, 'browser.session.close params');
    return this.sessions.close(requireString(record.sessionId, 'sessionId'));
  }

  private async resetSession(params: unknown): Promise<BrowserSession> {
    const record = requireRecord(params, 'browser.session.reset params');
    return this.sessions.reset(
      requireString(record.sessionId, 'sessionId'),
      readOptionalRecord<BrowserConfig>(record.config, 'config')
    );
  }

  private async executeAction(params: unknown): Promise<ActionResult> {
    const record = requireRecord(params, 'browser.action.execute params');
    const action = requireString(record.action, 'action') as BrowserActionName;
    const actionParams = readOptionalRecord<Record<string, unknown>>(record.params, 'params') ?? {};
    const config = readOptionalRecord<BrowserConfig>(record.config, 'config') ?? {};
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    const client = await this.sessions.getOrCreate(sessionId, config);

    return client.execute({
      action,
      params: actionParams,
    } as BrowserActionRequest);
  }

  private async executeActions(params: unknown): Promise<ActionResult[]> {
    const record = requireRecord(params, 'browser.actions.execute params');
    if (!Array.isArray(record.actions)) {
      throw new Error('actions must be an array');
    }

    const config = readOptionalRecord<BrowserConfig>(record.config, 'config') ?? {};
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    const client = await this.sessions.getOrCreate(sessionId, config);

    return client.executeMany(record.actions as BrowserActionRequest[]);
  }

  private async executeStep(params: unknown): Promise<BrowserStepExecutionResult> {
    const record = requireRecord(params, 'browser.step.execute params');
    const step = requireRecord(record.step, 'step') as unknown as BrowserStepConfig;
    const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : undefined;

    return this.stepExecutor.execute(step, { workspaceId });
  }

  private writeResponse(response: JsonRpcResponse): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

export function startBrowserMcpServer(options: BrowserMcpServerOptions = {}): BrowserMcpServer {
  const server = new BrowserMcpServer(options);
  server.start();
  return server;
}

export function getBrowserToolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      name: 'browser_session_create',
      description: 'Create a browser session with optional Playwright launch/context settings.',
      inputSchema: {
        type: 'object',
        properties: {
          config: { type: 'object' },
        },
      },
    },
    {
      name: 'browser_session_list',
      description: 'List active browser sessions.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_session_get',
      description: 'Get browser session state.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'browser_session_close',
      description: 'Close a browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'browser_session_reset',
      description: 'Reset a browser session, optionally replacing its browser config.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          config: { type: 'object' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'browser_action_execute',
      description: 'Execute one browser action in an existing or default session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          action: { type: 'string' },
          params: { type: 'object' },
          config: { type: 'object' },
        },
        required: ['action'],
      },
    },
    {
      name: 'browser_actions_execute',
      description: 'Execute multiple browser actions sequentially in one session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          actions: { type: 'array', items: { type: 'object' } },
          config: { type: 'object' },
        },
        required: ['actions'],
      },
    },
    {
      name: 'browser_step_execute',
      description: 'Execute a BrowserStepConfig using the workflow step executor.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          step: { type: 'object' },
        },
        required: ['step'],
      },
    },
  ];
}

function toMcpToolResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, undefined, 2),
      },
    ],
    isError,
  };
}

function isActionError(value: unknown): boolean {
  return isRecord(value) && value.success === false;
}

function hasActionErrors(value: unknown): boolean {
  return Array.isArray(value) && value.some(isActionError);
}

function toJsonRpcError(error: unknown): JsonRpcError {
  if (isRecord(error) && typeof error.code === 'number' && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
      data: error.data,
    };
  }

  return {
    code: -32603,
    message: error instanceof Error ? error.message : String(error),
  };
}

function jsonRpcMethodNotFound(method: string): JsonRpcError {
  return {
    code: -32601,
    message: `Method not found: ${method}`,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readOptionalRecord<T>(value: unknown, label: string): T | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, label) as T;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMainModule(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  startBrowserMcpServer();
}
