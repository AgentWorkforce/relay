/**
 * Adapter that implements {@link RunnerStepExecutor} on top of a
 * {@link ProcessBackend}. Relay owns agent configuration (CLI flags, env,
 * preset); the backend only provides "where to run" — create an isolated
 * environment, exec the command, destroy.
 *
 * The WorkflowRunner synthesizes one of these when a caller passes
 * `processBackend` without an explicit `executor`, so every existing
 * `executor.executeAgentStep(...)` call site transparently flows through
 * the backend (e.g. a cloud sandbox) without any further plumbing.
 */

import { buildCommand } from './process-spawner.js';
import type { ProcessBackend, AgentDefinition, WorkflowStep } from './types.js';
import type { RunnerStepExecutor } from './runner.js';

function shellEscape(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_\/.:,=+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandToShell(argv: string[]): string {
  return argv.map(shellEscape).join(' ');
}

function envToExportPrefix(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return '';
  const parts = Object.entries(env).map(([k, v]) => `${k}=${shellEscape(v)}`);
  return parts.join(' ') + ' ';
}

export interface ProcessBackendExecutorOptions {
  /** Env vars injected into every step (e.g. auth tokens, relayfile config). */
  env?: Record<string, string>;
}

export function createProcessBackendExecutor(
  backend: ProcessBackend,
  options: ProcessBackendExecutorOptions = {}
): RunnerStepExecutor {
  const baseEnv = options.env ?? {};

  return {
    async executeAgentStep(
      step: WorkflowStep,
      agentDef: AgentDefinition,
      resolvedTask: string,
      timeoutMs?: number
    ): Promise<string> {
      if (agentDef.cli === 'api') {
        throw new Error(
          `processBackend cannot execute cli "api" agents — api agents call the Anthropic API directly. ` +
            `Route agent "${agentDef.name}" through a subprocess CLI (claude, codex, etc.) or omit processBackend.`
        );
      }

      const extraArgs = agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : [];
      const argv = buildCommand(agentDef.cli, extraArgs, resolvedTask);
      const commandString = envToExportPrefix(baseEnv) + commandToShell(argv);

      const env = await backend.createEnvironment(step.name);
      try {
        const execOpts: {
          cwd?: string;
          env?: Record<string, string>;
          timeoutSeconds?: number;
        } = {};
        if (timeoutMs && timeoutMs > 0) {
          execOpts.timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        }
        const result = await env.exec(commandString, execOpts);
        if (result.exitCode !== 0) {
          const tail = result.output.slice(-2000);
          throw new Error(`Agent step "${step.name}" exited with code ${result.exitCode}: ${tail}`);
        }
        return result.output;
      } finally {
        await env.destroy().catch(() => undefined);
      }
    },

    async executeDeterministicStep(
      step: WorkflowStep,
      resolvedCommand: string,
      cwd: string
    ): Promise<{ output: string; exitCode: number }> {
      const env = await backend.createEnvironment(step.name);
      try {
        const execOpts: {
          cwd?: string;
          env?: Record<string, string>;
          timeoutSeconds?: number;
        } = { cwd };
        if (Object.keys(baseEnv).length > 0) execOpts.env = baseEnv;
        if (step.timeoutMs && step.timeoutMs > 0) {
          execOpts.timeoutSeconds = Math.max(1, Math.ceil(step.timeoutMs / 1000));
        }
        return await env.exec(resolvedCommand, execOpts);
      } finally {
        await env.destroy().catch(() => undefined);
      }
    },
  };
}
