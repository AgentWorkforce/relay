import { spawn } from 'node:child_process';

import { BaseGitHubAdapter } from './adapter.js';
import { appendQuery } from './actions/utils.js';
import {
  GitHubApiError,
  type GitHubApiRequestMethod,
  type GitHubApiRequestOptions,
  type GitHubRuntime,
  type GitHubRuntimeConfig,
  type GitHubUserSummary,
} from './types.js';

export interface GhCliCommandOptions {
  input?: string;
  parseJson?: boolean;
  allowEmpty?: boolean;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface GhCliCommandResult<TData = unknown> {
  args: string[];
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  data: TData;
}

export class GhCliError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      command: string;
      args: string[];
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = 'GhCliError';
    this.command = options.command;
    this.args = options.args;
    this.exitCode = options.exitCode;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.cause = options.cause;
  }
}

export class GhCliClient extends BaseGitHubAdapter {
  constructor(config: GitHubRuntimeConfig = {}) {
    super({
      ...config,
      runtime: 'local',
    });
  }

  getRuntime(): GitHubRuntime {
    return 'local';
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.runGhCommand(['auth', 'status'], {
        parseJson: false,
        timeout: Math.min(this.config.timeout, 10_000),
      });
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentUser(): Promise<GitHubUserSummary> {
    const user = await this.request<{
      id?: number;
      login?: string;
      name?: string | null;
      type?: string;
    }>('GET', '/user');

    if (!user.login) {
      throw new GitHubApiError('GitHub user response did not include a login.');
    }

    return {
      login: user.login,
      name: user.name ?? undefined,
      id: user.id,
      type: user.type,
    };
  }

  async request<TResponse = unknown>(
    method: GitHubApiRequestMethod,
    path: string,
    options: GitHubApiRequestOptions = {}
  ): Promise<TResponse> {
    return this.executeWithRetries(async () => {
      const request = this.buildApiCommand(method, path, options);
      const result = await this.runGhCommand<TResponse>(request.args, {
        input: request.input,
        parseJson: true,
        allowEmpty: true,
        timeout: options.timeout ?? this.config.timeout,
        signal: options.signal,
      });

      return result.data;
    });
  }

  runGhCommand<TData = unknown>(
    args: string[],
    options: GhCliCommandOptions = {}
  ): Promise<GhCliCommandResult<TData>> {
    const command = this.config.ghPath;
    const timeout = options.timeout ?? this.config.timeout;
    const env = {
      ...process.env,
      ...this.config.env,
      ...options.env,
    };

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd ?? this.config.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let finished = false;

      const finish = (callback: () => void): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        callback();
      };

      const rejectWith = (error: GhCliError): void => {
        finish(() => reject(error));
      };

      const abort = (): void => {
        child.kill('SIGTERM');
        rejectWith(
          new GhCliError(`gh command aborted: ${command} ${args.join(' ')}`, {
            command,
            args,
            stdout,
            stderr,
          })
        );
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        rejectWith(
          new GhCliError(`gh command timed out after ${timeout}ms: ${command} ${args.join(' ')}`, {
            command,
            args,
            stdout,
            stderr,
          })
        );
      }, timeout);

      if (options.signal?.aborted) {
        abort();
        return;
      }

      options.signal?.addEventListener('abort', abort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error) => {
        rejectWith(
          new GhCliError(`Failed to start gh command: ${error.message}`, {
            command,
            args,
            stdout,
            stderr,
            cause: error,
          })
        );
      });

      child.on('close', (exitCode) => {
        if (finished) {
          return;
        }

        if (exitCode !== 0) {
          rejectWith(
            new GhCliError(stderr.trim() || `gh command failed with exit code ${exitCode}`, {
              command,
              args,
              exitCode: exitCode ?? undefined,
              stdout,
              stderr,
            })
          );
          return;
        }

        try {
          const data = this.parseCommandOutput<TData>(stdout, options);
          finish(() =>
            resolve({
              args,
              command,
              exitCode: exitCode ?? 0,
              stdout,
              stderr,
              data,
            })
          );
        } catch (error) {
          rejectWith(
            new GhCliError(error instanceof Error ? error.message : String(error), {
              command,
              args,
              exitCode: exitCode ?? undefined,
              stdout,
              stderr,
              cause: error,
            })
          );
        }
      });

      if (typeof options.input === 'string') {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
  }

  private buildApiCommand(
    method: GitHubApiRequestMethod,
    path: string,
    options: GitHubApiRequestOptions
  ): { args: string[]; input?: string } {
    const args = [
      'api',
      appendQuery(path, options.query),
      '--method',
      method,
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      'X-GitHub-Api-Version: 2022-11-28',
    ];

    for (const [name, value] of Object.entries(options.headers ?? {})) {
      args.push('--header', `${name}: ${value}`);
    }

    if (typeof options.body !== 'undefined') {
      args.push('--input', '-');
      return {
        args,
        input: JSON.stringify(options.body),
      };
    }

    return { args };
  }

  private parseCommandOutput<TData>(stdout: string, options: GhCliCommandOptions): TData {
    if (options.parseJson === false) {
      return stdout as TData;
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      if (options.allowEmpty) {
        return undefined as TData;
      }

      throw new Error('gh command returned empty output where JSON was expected.');
    }

    try {
      return JSON.parse(trimmed) as TData;
    } catch (error) {
      throw new Error(
        `Failed to parse gh JSON output: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
