/**
 * Container Spawner Service
 *
 * Allows agents to spawn isolated Docker containers for specific tasks.
 * Requires Docker socket to be mounted: -v /var/run/docker.sock:/var/run/docker.sock
 *
 * Use cases:
 * - Running untrusted code in isolation
 * - Testing against different environments (Node versions, OS variants)
 * - Parallel task execution
 * - Language-specific toolchains
 */

import { spawn, execSync, ExecSyncOptions } from 'child_process';
import { existsSync } from 'fs';

export interface ContainerConfig {
  /** Docker image to use */
  image: string;
  /** Command to run (default: shell) */
  command?: string[];
  /** Working directory inside container */
  workdir?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Volumes to mount (host:container format) */
  volumes?: string[];
  /** Port mappings (host:container format) */
  ports?: string[];
  /** Memory limit (e.g., '512m', '2g') */
  memory?: string;
  /** CPU limit (e.g., '0.5', '2') */
  cpus?: string;
  /** Network mode (bridge, host, none) */
  network?: 'bridge' | 'host' | 'none';
  /** Remove container after exit */
  autoRemove?: boolean;
  /** Container name */
  name?: string;
  /** Timeout in ms */
  timeout?: number;
}

export interface ContainerResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  containerId?: string;
}

/**
 * Check if Docker is available
 */
export function isDockerAvailable(): boolean {
  // Check if socket exists
  if (!existsSync('/var/run/docker.sock')) {
    return false;
  }

  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build Docker command arguments from config
 */
function buildDockerArgs(config: ContainerConfig): string[] {
  const args: string[] = ['run'];

  // Auto-remove
  if (config.autoRemove !== false) {
    args.push('--rm');
  }

  // Name
  if (config.name) {
    args.push('--name', config.name);
  }

  // Working directory
  if (config.workdir) {
    args.push('-w', config.workdir);
  }

  // Environment variables
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Volumes
  if (config.volumes) {
    for (const vol of config.volumes) {
      args.push('-v', vol);
    }
  }

  // Ports
  if (config.ports) {
    for (const port of config.ports) {
      args.push('-p', port);
    }
  }

  // Resource limits
  if (config.memory) {
    args.push('--memory', config.memory);
  }
  if (config.cpus) {
    args.push('--cpus', config.cpus);
  }

  // Network
  if (config.network) {
    args.push('--network', config.network);
  }

  // Image
  args.push(config.image);

  // Command
  if (config.command && config.command.length > 0) {
    args.push(...config.command);
  }

  return args;
}

/**
 * Run a command in a new container and wait for completion
 */
export async function runInContainer(config: ContainerConfig): Promise<ContainerResult> {
  if (!isDockerAvailable()) {
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: 'Docker is not available. Mount /var/run/docker.sock to enable container spawning.',
    };
  }

  const args = buildDockerArgs(config);

  return new Promise((resolve) => {
    const proc = spawn('docker', args, {
      timeout: config.timeout || 60000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr: err.message,
      });
    });
  });
}

/**
 * Run a command in a container interactively (for TTY)
 */
export function runInteractive(config: ContainerConfig): { pid: number; containerId?: string } {
  if (!isDockerAvailable()) {
    throw new Error('Docker is not available');
  }

  const args = buildDockerArgs({ ...config, autoRemove: true });
  args.splice(1, 0, '-it'); // Add interactive + TTY flags

  const proc = spawn('docker', args, {
    stdio: 'inherit',
    detached: false,
  });

  return { pid: proc.pid || 0 };
}

/**
 * Start a container in the background
 */
export async function startContainer(config: ContainerConfig): Promise<{ containerId: string }> {
  if (!isDockerAvailable()) {
    throw new Error('Docker is not available');
  }

  const args = buildDockerArgs({ ...config, autoRemove: false });
  args.splice(1, 0, '-d'); // Add detach flag

  const result = execSync(`docker ${args.join(' ')}`, { encoding: 'utf-8' });
  const containerId = result.trim();

  return { containerId };
}

/**
 * Stop a running container
 */
export async function stopContainer(containerId: string): Promise<void> {
  execSync(`docker stop ${containerId}`, { stdio: 'pipe' });
}

/**
 * Execute a command in a running container
 */
export async function execInContainer(
  containerId: string,
  command: string[],
  options: { workdir?: string; env?: Record<string, string> } = {}
): Promise<ContainerResult> {
  const args = ['exec'];

  if (options.workdir) {
    args.push('-w', options.workdir);
  }

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  args.push(containerId, ...command);

  return new Promise((resolve) => {
    const proc = spawn('docker', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        exitCode: code,
        stdout,
        stderr,
        containerId,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        exitCode: null,
        stdout,
        stderr: err.message,
        containerId,
      });
    });
  });
}

/**
 * Pull a Docker image
 */
export async function pullImage(image: string): Promise<boolean> {
  if (!isDockerAvailable()) {
    return false;
  }

  try {
    execSync(`docker pull ${image}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * List running containers
 */
export function listContainers(): Array<{
  id: string;
  image: string;
  name: string;
  status: string;
}> {
  if (!isDockerAvailable()) {
    return [];
  }

  try {
    const output = execSync(
      'docker ps --format "{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}"',
      { encoding: 'utf-8' }
    );

    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, image, name, status] = line.split('|');
        return { id, image, name, status };
      });
  } catch {
    return [];
  }
}

// ============================================================================
// Predefined container configurations for common tasks
// ============================================================================

export const PRESET_CONTAINERS = {
  /** Node.js 20 environment */
  node20: {
    image: 'node:20-slim',
    workdir: '/workspace',
  },

  /** Python 3.11 environment */
  python311: {
    image: 'python:3.11-slim',
    workdir: '/workspace',
  },

  /** Go 1.21 environment */
  go121: {
    image: 'golang:1.21-alpine',
    workdir: '/workspace',
  },

  /** Rust environment */
  rust: {
    image: 'rust:slim',
    workdir: '/workspace',
  },

  /** Ubuntu with common tools */
  ubuntu: {
    image: 'ubuntu:22.04',
    workdir: '/workspace',
  },

  /** Alpine minimal */
  alpine: {
    image: 'alpine:3.18',
    workdir: '/workspace',
  },

  /** Playwright with browsers */
  playwright: {
    image: 'mcr.microsoft.com/playwright:latest',
    workdir: '/workspace',
  },
} as const;

/**
 * Run code in a language-specific container
 */
export async function runCode(
  language: 'node' | 'python' | 'go' | 'rust' | 'bash',
  code: string,
  options: { workspaceDir?: string; timeout?: number } = {}
): Promise<ContainerResult> {
  const configs: Record<string, { image: string; command: string[] }> = {
    node: { image: 'node:20-slim', command: ['node', '-e', code] },
    python: { image: 'python:3.11-slim', command: ['python', '-c', code] },
    go: { image: 'golang:1.21-alpine', command: ['go', 'run', '-'] },
    rust: { image: 'rust:slim', command: ['rustc', '--edition', '2021', '-', '-o', '/tmp/a', '&&', '/tmp/a'] },
    bash: { image: 'ubuntu:22.04', command: ['bash', '-c', code] },
  };

  const config = configs[language];
  if (!config) {
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: `Unknown language: ${language}`,
    };
  }

  return runInContainer({
    image: config.image,
    command: config.command,
    workdir: '/workspace',
    volumes: options.workspaceDir ? [`${options.workspaceDir}:/workspace`] : [],
    timeout: options.timeout,
    memory: '512m',
    cpus: '1',
  });
}
