import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTOCOL_VERSION,
  type AgentRuntime,
  type AgentSpec,
  type BrokerEvent,
  type BrokerStatus,
  type ProtocolEnvelope,
  type ProtocolError,
} from "./protocol.js";

export interface AgentRelayClientOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  brokerName?: string;
  channels?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface SpawnPtyInput {
  name: string;
  cli: string;
  args?: string[];
  channels?: string[];
  task?: string;
  /** Silence duration in seconds before emitting agent_idle (0 = disabled, default: 30). */
  idleThresholdSecs?: number;
}

export interface SpawnHeadlessClaudeInput {
  name: string;
  args?: string[];
  channels?: string[];
  task?: string;
}

export interface SendMessageInput {
  to: string;
  text: string;
  from?: string;
  threadId?: string;
  priority?: number;
}

export interface ListAgent {
  name: string;
  runtime: AgentRuntime;
  channels: string[];
  parent?: string;
  pid?: number;
}

interface PendingRequest {
  expectedType: "ok" | "hello_ack";
  resolve: (value: ProtocolEnvelope<unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ParsedEnvelope {
  v: number;
  type: string;
  request_id?: string;
  payload: unknown;
}

export class AgentRelayProtocolError extends Error {
  code: string;
  retryable: boolean;
  data?: unknown;

  constructor(payload: ProtocolError) {
    super(payload.message);
    this.name = "AgentRelayProtocolError";
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.data = payload.data;
  }
}

export class AgentRelayProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRelayProcessError";
  }
}

export class AgentRelayClient {
  private readonly options: Required<AgentRelayClientOptions>;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutRl?: ReadlineInterface;
  private stderrRl?: ReadlineInterface;
  private requestSeq = 0;
  private pending = new Map<string, PendingRequest>();
  private startingPromise?: Promise<void>;
  private eventListeners = new Set<(event: BrokerEvent) => void>();
  private stderrListeners = new Set<(line: string) => void>();
  private exitPromise?: Promise<void>;

  constructor(options: AgentRelayClientOptions = {}) {
    this.options = {
      binaryPath: options.binaryPath ?? resolveDefaultBinaryPath(),
      binaryArgs: options.binaryArgs ?? [],
      brokerName: options.brokerName ?? "broker",
      channels: options.channels ?? ["general"],
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 3_000,
      clientName: options.clientName ?? "@agent-relay/broker-sdk",
      clientVersion: options.clientVersion ?? "0.1.0",
    };
  }

  static async start(options: AgentRelayClientOptions = {}): Promise<AgentRelayClient> {
    const client = new AgentRelayClient(options);
    await client.start();
    return client;
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onBrokerStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = this.startInternal();
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = undefined;
    }
  }

  async spawnPty(input: SpawnPtyInput): Promise<{ name: string; runtime: AgentRuntime }> {
    await this.start();
    const agent: AgentSpec = {
      name: input.name,
      runtime: "pty",
      cli: input.cli,
      args: input.args ?? [],
      channels: input.channels ?? [],
    };
    const result = await this.requestOk<{ name: string; runtime: AgentRuntime }>("spawn_agent", {
      agent,
      ...(input.task != null ? { initial_task: input.task } : {}),
      ...(input.idleThresholdSecs != null ? { idle_threshold_secs: input.idleThresholdSecs } : {}),
    });
    return result;
  }

  async spawnHeadlessClaude(
    input: SpawnHeadlessClaudeInput,
  ): Promise<{ name: string; runtime: AgentRuntime }> {
    await this.start();
    const agent: AgentSpec = {
      name: input.name,
      runtime: "headless_claude",
      args: input.args ?? [],
      channels: input.channels ?? [],
    };
    const result = await this.requestOk<{ name: string; runtime: AgentRuntime }>("spawn_agent", {
      agent,
      ...(input.task != null ? { initial_task: input.task } : {}),
    });
    return result;
  }

  async release(name: string): Promise<{ name: string }> {
    await this.start();
    return this.requestOk<{ name: string }>("release_agent", { name });
  }

  async sendMessage(
    input: SendMessageInput,
  ): Promise<{ event_id: string; targets: string[] }> {
    await this.start();
    try {
      return await this.requestOk<{ event_id: string; targets: string[] }>("send_message", {
        to: input.to,
        text: input.text,
        from: input.from,
        thread_id: input.threadId,
        priority: input.priority,
      });
    } catch (error) {
      if (error instanceof AgentRelayProtocolError && error.code === "unsupported_operation") {
        return { event_id: "unsupported_operation", targets: [] };
      }
      throw error;
    }
  }

  async listAgents(): Promise<ListAgent[]> {
    await this.start();
    const result = await this.requestOk<{ agents: ListAgent[] }>("list_agents", {});
    return result.agents;
  }

  async getStatus(): Promise<BrokerStatus> {
    await this.start();
    return this.requestOk<BrokerStatus>("get_status", {});
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }

    try {
      await this.requestOk("shutdown", {});
    } catch {
      // Continue shutdown path if broker is already unhealthy.
    }

    const child = this.child;
    const wait = this.exitPromise ?? Promise.resolve();
    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }, this.options.shutdownTimeoutMs);

    try {
      await wait;
    } finally {
      clearTimeout(timeout);
      if (this.child) {
        this.child.kill("SIGKILL");
      }
    }
  }

  async waitForExit(): Promise<void> {
    if (!this.child) {
      return;
    }
    await this.exitPromise;
  }

  private async startInternal(): Promise<void> {
    const resolvedBinary = expandTilde(this.options.binaryPath);
    if (isExplicitPath(this.options.binaryPath) && !fs.existsSync(resolvedBinary)) {
      throw new AgentRelayProcessError(`broker binary not found: ${this.options.binaryPath}`);
    }

    const args = [
      ...this.options.binaryArgs,
      "init",
      "--name",
      this.options.brokerName,
      "--channels",
      this.options.channels.join(","),
    ];

    // Ensure the SDK bin directory (containing agent-relay + relay_send) is on
    // PATH so spawned workers can find relay_send without any user setup.
    const env = { ...this.options.env };
    if (isExplicitPath(this.options.binaryPath)) {
      const binDir = path.dirname(path.resolve(resolvedBinary));
      const currentPath = env.PATH ?? env.Path ?? "";
      if (!currentPath.split(path.delimiter).includes(binDir)) {
        env.PATH = `${binDir}${path.delimiter}${currentPath}`;
      }
    }

    const child = spawn(resolvedBinary, args, {
      cwd: this.options.cwd,
      env,
      stdio: "pipe",
    });

    this.child = child;
    this.stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });

    this.stdoutRl.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    this.stderrRl.on("line", (line) => {
      for (const listener of this.stderrListeners) {
        listener(line);
      }
    });

    this.exitPromise = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        const error = new AgentRelayProcessError(
          `broker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
        this.failAllPending(error);
        this.disposeProcessHandles();
        resolve();
      });
      child.once("error", (error) => {
        this.failAllPending(error);
        this.disposeProcessHandles();
        resolve();
      });
    });

    await this.requestHello();
  }

  private disposeProcessHandles(): void {
    this.stdoutRl?.close();
    this.stderrRl?.close();
    this.stdoutRl = undefined;
    this.stderrRl = undefined;
    this.child = undefined;
    this.exitPromise = undefined;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleStdoutLine(line: string): void {
    let parsed: ParsedEnvelope;
    try {
      parsed = JSON.parse(line) as ParsedEnvelope;
    } catch {
      // Non-protocol output should not crash the SDK.
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }
    if (parsed.v !== PROTOCOL_VERSION || typeof parsed.type !== "string") {
      return;
    }

    const envelope: ProtocolEnvelope<unknown> = {
      v: parsed.v,
      type: parsed.type,
      request_id: parsed.request_id,
      payload: parsed.payload,
    };

    if (envelope.type === "event") {
      const payload = envelope.payload as BrokerEvent;
      for (const listener of this.eventListeners) {
        listener(payload);
      }
      return;
    }

    if (!envelope.request_id) {
      return;
    }

    const pending = this.pending.get(envelope.request_id);
    if (!pending) {
      return;
    }

    if (envelope.type === "error") {
      clearTimeout(pending.timeout);
      this.pending.delete(envelope.request_id);
      pending.reject(new AgentRelayProtocolError(envelope.payload as ProtocolError));
      return;
    }

    if (envelope.type !== pending.expectedType) {
      clearTimeout(pending.timeout);
      this.pending.delete(envelope.request_id);
      pending.reject(
        new AgentRelayProcessError(
          `unexpected response type '${envelope.type}' for request '${envelope.request_id}' (expected '${pending.expectedType}')`,
        ),
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(envelope.request_id);
    pending.resolve(envelope);
  }

  private async requestHello(): Promise<{ broker_version: string; protocol_version: number }> {
    const payload = {
      client_name: this.options.clientName,
      client_version: this.options.clientVersion,
    };
    const frame = await this.sendRequest("hello", payload, "hello_ack");
    return frame.payload as { broker_version: string; protocol_version: number };
  }

  private async requestOk<T = unknown>(type: string, payload: unknown): Promise<T> {
    const frame = await this.sendRequest(type, payload, "ok");
    const result = frame.payload as { result: T };
    return result.result;
  }

  private async sendRequest(
    type: string,
    payload: unknown,
    expectedType: "ok" | "hello_ack",
  ): Promise<ProtocolEnvelope<unknown>> {
    if (!this.child) {
      throw new AgentRelayProcessError("broker is not running");
    }

    const request_id = `req_${++this.requestSeq}`;
    const message: ProtocolEnvelope<unknown> = {
      v: PROTOCOL_VERSION,
      type,
      request_id,
      payload,
    };

    const responsePromise = new Promise<ProtocolEnvelope<unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request_id);
        reject(
          new AgentRelayProcessError(
            `request timed out after ${this.options.requestTimeoutMs}ms (type='${type}', request_id='${request_id}')`,
          ),
        );
      }, this.options.requestTimeoutMs);

      this.pending.set(request_id, {
        expectedType,
        resolve,
        reject,
        timeout,
      });
    });

    const line = `${JSON.stringify(message)}\n`;
    if (!this.child.stdin.write(line)) {
      await once(this.child.stdin, "drain");
    }

    return responsePromise;
  }
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    const home = os.homedir();
    return path.join(home, p.slice(2));
  }
  return p;
}

function isExplicitPath(binaryPath: string): boolean {
  return (
    binaryPath.includes("/") ||
    binaryPath.includes("\\") ||
    binaryPath.startsWith(".") ||
    binaryPath.startsWith("~")
  );
}

function resolveDefaultBinaryPath(): string {
  const exe = process.platform === "win32" ? "agent-relay.exe" : "agent-relay";
  const brokerExe = process.platform === "win32" ? "agent-relay-broker.exe" : "agent-relay-broker";

  // 1. Check for bundled broker binary in SDK package (npm install)
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.resolve(moduleDir, "..", "bin", exe);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  // 2. Check for standalone broker binary in ~/.agent-relay/bin/ (install.sh)
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const standaloneBroker = path.join(homeDir, ".agent-relay", "bin", brokerExe);
  if (fs.existsSync(standaloneBroker)) {
    return standaloneBroker;
  }

  // 3. Fall back to agent-relay on PATH (may be Node CLI — will fail for broker ops)
  return "agent-relay";
}
