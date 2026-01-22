import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  RelayFileWriter,
  getRelayPaths,
  getBaseRelayPaths,
  getAgentOutboxTemplate,
  ensureBaseDirectories,
} from './relay-file-writer.js';

describe('RelayFileWriter', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Save original env
    originalEnv = { ...process.env };

    // Create temp test directory
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-file-writer-test-'));

    // Set test data dir
    process.env.AGENT_RELAY_DATA_DIR = testDir;
    delete process.env.WORKSPACE_ID;
  });

  afterEach(async () => {
    // Restore original env
    process.env = originalEnv;

    // Clean up test directory
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create writer with agent name', () => {
      const writer = new RelayFileWriter('TestAgent');
      const paths = writer.getPaths();

      expect(paths.agentName).toBe('TestAgent');
      expect(paths.isWorkspace).toBe(false);
      expect(paths.agentOutbox).toContain('TestAgent');
    });

    it('should use workspace paths when WORKSPACE_ID is set', () => {
      process.env.WORKSPACE_ID = 'test-workspace-123';

      const writer = new RelayFileWriter('TestAgent');
      const paths = writer.getPaths();

      expect(paths.isWorkspace).toBe(true);
      expect(paths.rootDir).toBe('/tmp/relay/test-workspace-123');
      expect(paths.agentOutbox).toBe('/tmp/relay/test-workspace-123/outbox/TestAgent');
    });

    it('should hash long workspace IDs', () => {
      // Create a workspace ID that would result in path > 107 chars
      const longWorkspaceId = 'very-long-workspace-id-that-would-exceed-the-unix-socket-path-limit-of-107-characters-'.repeat(2);
      process.env.WORKSPACE_ID = longWorkspaceId;

      const writer = new RelayFileWriter('TestAgent');
      const paths = writer.getPaths();

      expect(paths.isWorkspace).toBe(true);
      // Should be using hashed ID (12 chars)
      expect(paths.rootDir).toMatch(/^\/tmp\/relay\/[a-f0-9]{12}$/);
    });
  });

  describe('getOutboxPath', () => {
    it('should return canonical path for local mode', () => {
      const writer = new RelayFileWriter('TestAgent');
      const outboxPath = writer.getOutboxPath();
      const paths = writer.getPaths();

      // Should return the canonical path (same as agentOutbox)
      expect(outboxPath).toBe(paths.agentOutbox);
      expect(outboxPath).toContain('TestAgent');
    });

    it('should return workspace path for workspace mode', () => {
      process.env.WORKSPACE_ID = 'test-workspace';

      const writer = new RelayFileWriter('TestAgent');
      const outboxPath = writer.getOutboxPath();

      expect(outboxPath).toBe('/tmp/relay/test-workspace/outbox/TestAgent');
    });
  });

  describe('ensureDirectories', () => {
    it('should create agent directories', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.ensureDirectories();

      const paths = writer.getPaths();
      expect(fs.existsSync(paths.agentOutbox)).toBe(true);
      expect(fs.existsSync(paths.agentAttachments)).toBe(true);
      expect(fs.existsSync(paths.metaDir)).toBe(true);
    });
  });

  describe('writeMessage', () => {
    it('should write message to outbox', async () => {
      const writer = new RelayFileWriter('TestAgent');
      const content = 'TO: Lead\n\nACK: Task received';

      const filePath = await writer.writeMessage('ack', content);

      expect(fs.existsSync(filePath)).toBe(true);
      const written = await fs.promises.readFile(filePath, 'utf-8');
      expect(written).toBe(content);
    });

    it('should create directories if needed', async () => {
      const writer = new RelayFileWriter('NewAgent');
      const content = 'TO: *\n\nHello';

      await writer.writeMessage('msg', content);

      const paths = writer.getPaths();
      expect(fs.existsSync(paths.agentOutbox)).toBe(true);
    });
  });

  describe('writeAttachment', () => {
    it('should write attachment with timestamp directory', async () => {
      const writer = new RelayFileWriter('TestAgent');
      const data = Buffer.from('test attachment data');

      const result = await writer.writeAttachment('test.txt', data);

      expect(fs.existsSync(result.path)).toBe(true);
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
      expect(result.relativePath).toContain('TestAgent');
      expect(result.relativePath).toContain('test.txt');
    });
  });

  describe('readMessage', () => {
    it('should read existing message', async () => {
      const writer = new RelayFileWriter('TestAgent');
      const content = 'TO: Lead\n\nTest message';
      await writer.writeMessage('msg', content);

      const read = await writer.readMessage('msg');

      expect(read).toBe(content);
    });

    it('should return null for non-existent message', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.ensureDirectories();

      const read = await writer.readMessage('nonexistent');

      expect(read).toBeNull();
    });
  });

  describe('deleteMessage', () => {
    it('should delete existing message', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.writeMessage('msg', 'content');

      const deleted = await writer.deleteMessage('msg');

      expect(deleted).toBe(true);
      const read = await writer.readMessage('msg');
      expect(read).toBeNull();
    });

    it('should return false for non-existent message', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.ensureDirectories();

      const deleted = await writer.deleteMessage('nonexistent');

      expect(deleted).toBe(false);
    });
  });

  describe('listMessages', () => {
    it('should list all messages in outbox', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.writeMessage('msg1', 'content1');
      await writer.writeMessage('msg2', 'content2');
      await writer.writeMessage('ack', 'content3');

      const messages = await writer.listMessages();

      expect(messages).toHaveLength(3);
      expect(messages).toContain('msg1');
      expect(messages).toContain('msg2');
      expect(messages).toContain('ack');
    });

    it('should return empty array for empty outbox', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.ensureDirectories();

      const messages = await writer.listMessages();

      expect(messages).toEqual([]);
    });
  });

  describe('writeMeta', () => {
    it('should write string metadata', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.ensureDirectories();

      const filePath = await writer.writeMeta('config', 'test config');

      expect(fs.existsSync(filePath)).toBe(true);
      const content = await fs.promises.readFile(filePath, 'utf-8');
      expect(content).toBe('test config');
    });

    it('should write object metadata as JSON', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.ensureDirectories();

      const data = { key: 'value', nested: { num: 123 } };
      await writer.writeMeta('state.json', data);

      const read = await writer.readMeta('state.json', true);
      expect(read).toEqual(data);
    });
  });

  describe('readMeta', () => {
    it('should read string metadata', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.writeMeta('config', 'test value');

      const read = await writer.readMeta('config');

      expect(read).toBe('test value');
    });

    it('should parse JSON metadata when requested', async () => {
      const writer = new RelayFileWriter('TestAgent');
      const data = { key: 'value' };
      await writer.writeMeta('data.json', data);

      const read = await writer.readMeta<typeof data>('data.json', true);

      expect(read).toEqual(data);
    });

    it('should return null for non-existent metadata', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.ensureDirectories();

      const read = await writer.readMeta('nonexistent');

      expect(read).toBeNull();
    });
  });

  describe('cleanOutbox', () => {
    it('should remove all messages from outbox', async () => {
      const writer = new RelayFileWriter('TestAgent');
      await writer.writeMessage('msg1', 'content1');
      await writer.writeMessage('msg2', 'content2');

      await writer.cleanOutbox();

      const messages = await writer.listMessages();
      expect(messages).toEqual([]);
    });
  });
});

describe('Utility Functions', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-util-test-'));
    process.env.AGENT_RELAY_DATA_DIR = testDir;
    delete process.env.WORKSPACE_ID;
  });

  afterEach(async () => {
    process.env = originalEnv;
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('getRelayPaths', () => {
    it('should return paths for agent', () => {
      const paths = getRelayPaths('TestAgent');

      expect(paths.agentName).toBe('TestAgent');
      expect(paths.agentOutbox).toContain('TestAgent');
    });
  });

  describe('getBaseRelayPaths', () => {
    it('should return local paths without workspace', () => {
      const paths = getBaseRelayPaths();

      expect(paths.rootDir).toBe(testDir);
      expect(paths.outboxDir).toBe(path.join(testDir, 'outbox'));
    });

    it('should return workspace paths with workspace ID', () => {
      const paths = getBaseRelayPaths('test-workspace');

      expect(paths.rootDir).toBe('/tmp/relay/test-workspace');
    });
  });

  describe('getAgentOutboxTemplate', () => {
    it('should return $AGENT_RELAY_OUTBOX env var', () => {
      const template = getAgentOutboxTemplate();

      // Should use the AGENT_RELAY_OUTBOX env var (set by orchestrator)
      expect(template).toBe('$AGENT_RELAY_OUTBOX');
    });

    it('should return $AGENT_RELAY_OUTBOX regardless of arg (deprecated param)', () => {
      // The agentNameVar parameter is deprecated - always returns env var
      const template = getAgentOutboxTemplate('${name}');

      expect(template).toBe('$AGENT_RELAY_OUTBOX');
    });
  });

  describe('ensureBaseDirectories', () => {
    it('should create all base directories', async () => {
      const paths = await ensureBaseDirectories();

      expect(fs.existsSync(paths.outboxDir)).toBe(true);
      expect(fs.existsSync(paths.attachmentsDir)).toBe(true);
      expect(fs.existsSync(paths.metaDir)).toBe(true);
    });
  });
});
