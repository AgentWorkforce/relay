import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  discoverSocket,
  detectCloudWorkspace,
  isCloudWorkspace,
  getCloudSocketPath,
  getCloudOutboxPath,
  getConnectionInfo,
  getCloudEnvironmentSummary,
  discoverAgentName,
} from './discovery.js';

// Mock the fs module
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

// Mock @agent-relay/config
vi.mock('@agent-relay/config', () => ({
  findProjectRoot: vi.fn(() => null),
}));

describe('Discovery (single source of truth)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WORKSPACE_ID;
    delete process.env.CLOUD_API_URL;
    delete process.env.WORKSPACE_TOKEN;
    delete process.env.RELAY_SOCKET;
    delete process.env.RELAY_PROJECT;
    delete process.env.WORKSPACE_OWNER_USER_ID;
    delete process.env.RELAY_AGENT_NAME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('detectCloudWorkspace', () => {
    it('returns null when cloud env vars are not set', () => {
      expect(detectCloudWorkspace()).toBeNull();
    });

    it('returns null when only WORKSPACE_ID is set', () => {
      process.env.WORKSPACE_ID = 'test-workspace';
      expect(detectCloudWorkspace()).toBeNull();
    });

    it('returns null when only CLOUD_API_URL is set', () => {
      process.env.CLOUD_API_URL = 'https://api.example.com';
      expect(detectCloudWorkspace()).toBeNull();
    });

    it('returns workspace info when both vars are set', () => {
      process.env.WORKSPACE_ID = 'test-workspace';
      process.env.CLOUD_API_URL = 'https://api.example.com';
      process.env.WORKSPACE_TOKEN = 'secret-token';
      process.env.WORKSPACE_OWNER_USER_ID = 'user-123';

      const result = detectCloudWorkspace();

      expect(result).toEqual({
        workspaceId: 'test-workspace',
        cloudApiUrl: 'https://api.example.com',
        workspaceToken: 'secret-token',
        ownerUserId: 'user-123',
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
      expect(getCloudSocketPath('my-ws')).toBe('/tmp/relay/my-ws/sockets/daemon.sock');
    });
  });

  describe('getCloudOutboxPath', () => {
    it('returns workspace-namespaced outbox path', () => {
      expect(getCloudOutboxPath('my-ws', 'Agent1')).toBe('/tmp/relay/my-ws/outbox/Agent1');
    });
  });

  describe('discoverSocket', () => {
    it('uses override socketPath option', () => {
      const result = discoverSocket({ socketPath: '/custom/path.sock' });
      expect(result?.socketPath).toBe('/custom/path.sock');
      expect(result?.source).toBe('env');
    });

    it('uses RELAY_SOCKET env var', () => {
      process.env.RELAY_SOCKET = '/tmp/test.sock';
      const result = discoverSocket();
      expect(result?.socketPath).toBe('/tmp/test.sock');
      expect(result?.source).toBe('env');
    });

    it('uses cloud workspace socket when in cloud (even without file)', () => {
      process.env.WORKSPACE_ID = 'cloud-ws';
      process.env.CLOUD_API_URL = 'https://api.example.com';
      vi.mocked(existsSync).mockReturnValue(false);

      const result = discoverSocket();
      expect(result?.socketPath).toBe('/tmp/relay/cloud-ws/sockets/daemon.sock');
      expect(result?.source).toBe('cloud');
      expect(result?.isCloud).toBe(true);
    });

    it('env override takes priority over cloud workspace', () => {
      process.env.RELAY_SOCKET = '/explicit/override.sock';
      process.env.WORKSPACE_ID = 'cloud-ws';
      process.env.CLOUD_API_URL = 'https://api.example.com';

      const result = discoverSocket();
      expect(result?.socketPath).toBe('/explicit/override.sock');
      expect(result?.source).toBe('env');
    });

    it('uses RELAY_PROJECT env var', () => {
      process.env.RELAY_PROJECT = 'myproject';
      vi.mocked(existsSync).mockReturnValue(false);

      const result = discoverSocket();
      expect(result?.project).toBe('myproject');
      expect(result?.source).toBe('env');
    });

    it('returns null when nothing found', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = discoverSocket();
      expect(result).toBeNull();
    });
  });

  describe('getConnectionInfo', () => {
    it('returns null when no socket found', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(getConnectionInfo()).toBeNull();
    });

    it('returns connection info with cloud details', () => {
      process.env.WORKSPACE_ID = 'ws-123';
      process.env.CLOUD_API_URL = 'https://api.example.com';

      const result = getConnectionInfo();
      expect(result?.isCloud).toBe(true);
      expect(result?.daemonUrl).toBe('https://api.example.com');
      expect(result?.workspace?.workspaceId).toBe('ws-123');
    });
  });

  describe('getCloudEnvironmentSummary', () => {
    it('returns env var summary', () => {
      process.env.WORKSPACE_ID = 'test';
      process.env.WORKSPACE_TOKEN = 'secret';

      const summary = getCloudEnvironmentSummary();
      expect(summary.WORKSPACE_ID).toBe('test');
      expect(summary.WORKSPACE_TOKEN).toBe('[set]');
    });
  });

  describe('discoverAgentName', () => {
    it('returns RELAY_AGENT_NAME env var when set', () => {
      process.env.RELAY_AGENT_NAME = 'TestAgent';
      expect(discoverAgentName()).toBe('TestAgent');
    });

    it('returns null when no identity found', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(discoverAgentName()).toBeNull();
    });
  });
});
