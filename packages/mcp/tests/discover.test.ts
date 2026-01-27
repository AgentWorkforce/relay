import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  discoverSocket,
  detectCloudWorkspace,
  isCloudWorkspace,
  getCloudSocketPath,
  getCloudOutboxPath,
} from '../src/cloud.js';

// Mock the fs module with all required exports
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('Cloud Detection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Clear cloud env vars
    delete process.env.WORKSPACE_ID;
    delete process.env.CLOUD_API_URL;
    delete process.env.WORKSPACE_TOKEN;
    delete process.env.RELAY_SOCKET;
    delete process.env.RELAY_PROJECT;
    delete process.env.WORKSPACE_OWNER_USER_ID;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('detectCloudWorkspace', () => {
    it('returns null when cloud env vars are not set', () => {
      const result = detectCloudWorkspace();
      expect(result).toBeNull();
    });

    it('returns null when only WORKSPACE_ID is set', () => {
      process.env.WORKSPACE_ID = 'test-workspace';
      const result = detectCloudWorkspace();
      expect(result).toBeNull();
    });

    it('returns null when only CLOUD_API_URL is set', () => {
      process.env.CLOUD_API_URL = 'https://api.example.com';
      const result = detectCloudWorkspace();
      expect(result).toBeNull();
    });

    it('returns workspace info when both vars are set', () => {
      process.env.WORKSPACE_ID = 'test-workspace';
      process.env.CLOUD_API_URL = 'https://api.example.com';
      process.env.WORKSPACE_TOKEN = 'secret-token';

      const result = detectCloudWorkspace();

      expect(result).toEqual({
        workspaceId: 'test-workspace',
        cloudApiUrl: 'https://api.example.com',
        workspaceToken: 'secret-token',
        ownerUserId: undefined,
      });
    });
  });

  describe('isCloudWorkspace', () => {
    it('returns false when not in cloud', () => {
      expect(isCloudWorkspace()).toBe(false);
    });

    it('returns true when in cloud', () => {
      process.env.WORKSPACE_ID = 'test-workspace';
      process.env.CLOUD_API_URL = 'https://api.example.com';
      expect(isCloudWorkspace()).toBe(true);
    });
  });

  describe('getCloudSocketPath', () => {
    it('returns workspace-namespaced socket path', () => {
      const path = getCloudSocketPath('my-workspace');
      expect(path).toBe('/tmp/relay/my-workspace/sockets/daemon.sock');
    });
  });

  describe('getCloudOutboxPath', () => {
    it('returns workspace-namespaced outbox path', () => {
      const path = getCloudOutboxPath('my-workspace', 'AgentA');
      expect(path).toBe('/tmp/relay/my-workspace/outbox/AgentA');
    });
  });
});

describe('Socket Discovery', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WORKSPACE_ID;
    delete process.env.CLOUD_API_URL;
    delete process.env.RELAY_SOCKET;
    delete process.env.RELAY_PROJECT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('discoverSocket', () => {
    it('uses RELAY_SOCKET env var first', () => {
      process.env.RELAY_SOCKET = '/tmp/test.sock';
      vi.mocked(existsSync).mockReturnValue(true);

      const result = discoverSocket();

      expect(result?.socketPath).toBe('/tmp/test.sock');
      expect(result?.source).toBe('env');
      expect(result?.isCloud).toBe(false);
    });

    it('uses socketPath option when provided', () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const result = discoverSocket({ socketPath: '/custom/path.sock' });

      expect(result?.socketPath).toBe('/custom/path.sock');
      expect(result?.source).toBe('env');
    });

    it('uses cloud workspace socket when in cloud', () => {
      process.env.WORKSPACE_ID = 'test-workspace';
      process.env.CLOUD_API_URL = 'https://api.example.com';
      vi.mocked(existsSync).mockImplementation((path) => {
        return String(path) === '/tmp/relay/test-workspace/sockets/daemon.sock';
      });

      const result = discoverSocket();

      expect(result?.socketPath).toBe('/tmp/relay/test-workspace/sockets/daemon.sock');
      expect(result?.source).toBe('cloud');
      expect(result?.isCloud).toBe(true);
      expect(result?.workspace?.workspaceId).toBe('test-workspace');
    });

    it('returns null when no socket found', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readdirSync).mockReturnValue([]);

      const result = discoverSocket();

      expect(result).toBeNull();
    });

    it('uses RELAY_PROJECT env var for project lookup', () => {
      process.env.RELAY_PROJECT = 'myproject';
      vi.mocked(existsSync).mockImplementation((path) => {
        return String(path).includes('myproject');
      });

      const result = discoverSocket();

      expect(result?.project).toBe('myproject');
      expect(result?.source).toBe('env');
      expect(result?.isCloud).toBe(false);
    });

    it('uses cwd config when present', () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        const p = String(path);
        return p.includes('.relay/config.json') || p === '/my/socket.sock';
      });
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          socketPath: '/my/socket.sock',
          project: 'local-project',
        })
      );

      const result = discoverSocket();

      expect(result?.socketPath).toBe('/my/socket.sock');
      expect(result?.project).toBe('local-project');
      expect(result?.source).toBe('cwd');
    });
  });
});
