import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  DEFAULT_INBOX_DIR,
  getAgentName,
  getInboxPath,
  inboxExists,
  readInbox,
  hasUnreadMessages,
  countMessages,
  parseMessages,
  formatMessagePreview,
  buildBlockReason,
} from './utils.js';

function makeTempDir(): string {
  const base = path.join(process.cwd(), '.tmp-inbox-check-tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'utils-'));
  return dir;
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Inbox Check Utils', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) {
      cleanup(tempDir);
    }
    vi.unstubAllEnvs();
  });

  describe('DEFAULT_INBOX_DIR', () => {
    it('has expected default value', () => {
      expect(DEFAULT_INBOX_DIR).toBe('/tmp/agent-relay');
    });
  });

  describe('getAgentName', () => {
    it('returns undefined when AGENT_RELAY_NAME is not set', () => {
      delete process.env.AGENT_RELAY_NAME;
      expect(getAgentName()).toBeUndefined();
    });

    it('returns agent name from environment variable', () => {
      vi.stubEnv('AGENT_RELAY_NAME', 'TestAgent');
      expect(getAgentName()).toBe('TestAgent');
    });
  });

  describe('getInboxPath', () => {
    it('returns correct path with agentName in config', () => {
      const result = getInboxPath({ inboxDir: tempDir, agentName: 'MyAgent' });
      expect(result).toBe(path.join(tempDir, 'MyAgent', 'inbox.md'));
    });

    it('uses env var when agentName not in config', () => {
      vi.stubEnv('AGENT_RELAY_NAME', 'EnvAgent');
      const result = getInboxPath({ inboxDir: tempDir });
      expect(result).toBe(path.join(tempDir, 'EnvAgent', 'inbox.md'));
    });

    it('throws when no agent name available', () => {
      delete process.env.AGENT_RELAY_NAME;
      expect(() => getInboxPath({ inboxDir: tempDir })).toThrow(
        'Agent name not configured'
      );
    });
  });

  describe('inboxExists', () => {
    it('returns false when inbox does not exist', () => {
      const inboxPath = path.join(tempDir, 'nonexistent', 'inbox.md');
      expect(inboxExists(inboxPath)).toBe(false);
    });

    it('returns true when inbox exists', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, 'content');
      expect(inboxExists(inboxPath)).toBe(true);
    });
  });

  describe('readInbox', () => {
    it('returns empty string when inbox does not exist', () => {
      const inboxPath = path.join(tempDir, 'nonexistent', 'inbox.md');
      expect(readInbox(inboxPath)).toBe('');
    });

    it('returns file content when inbox exists', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, 'Hello World');
      expect(readInbox(inboxPath)).toBe('Hello World');
    });
  });

  describe('hasUnreadMessages', () => {
    it('returns false for empty inbox', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, '');
      expect(hasUnreadMessages(inboxPath)).toBe(false);
    });

    it('returns false when no message headers present', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, '# Inbox\nSome content without messages');
      expect(hasUnreadMessages(inboxPath)).toBe(false);
    });

    it('returns true when message headers present', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, '## Message from Agent | 2025-01-01\nHello');
      expect(hasUnreadMessages(inboxPath)).toBe(true);
    });
  });

  describe('countMessages', () => {
    it('returns 0 for empty inbox', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, '');
      expect(countMessages(inboxPath)).toBe(0);
    });

    it('returns 0 for nonexistent inbox', () => {
      const inboxPath = path.join(tempDir, 'nonexistent', 'inbox.md');
      expect(countMessages(inboxPath)).toBe(0);
    });

    it('counts messages correctly', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      const content = `## Message from AgentA | 2025-01-01
Hello

## Message from AgentB | 2025-01-02
World

## Message from AgentC | 2025-01-03
Test`;
      fs.writeFileSync(inboxPath, content);
      expect(countMessages(inboxPath)).toBe(3);
    });
  });

  describe('parseMessages', () => {
    it('returns empty array for empty inbox', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, '');
      expect(parseMessages(inboxPath)).toEqual([]);
    });

    it('parses messages correctly', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      const content = `## Message from AgentA | 2025-01-01T10:00:00Z
Hello World

## Message from AgentB | 2025-01-02T12:00:00Z
Second message`;
      fs.writeFileSync(inboxPath, content);

      const messages = parseMessages(inboxPath);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        from: 'AgentA',
        timestamp: '2025-01-01T10:00:00Z',
        body: 'Hello World',
      });
      expect(messages[1]).toEqual({
        from: 'AgentB',
        timestamp: '2025-01-02T12:00:00Z',
        body: 'Second message',
      });
    });

    it('ignores content before first message', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      const content = `# Inbox Header
Some intro text

## Message from Agent | 2025-01-01T10:00:00Z
Actual message`;
      fs.writeFileSync(inboxPath, content);

      const messages = parseMessages(inboxPath);
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('Agent');
    });
  });

  describe('formatMessagePreview', () => {
    it('returns full message if short', () => {
      const msg = { from: 'Agent', timestamp: '2025-01-01', body: 'Hello' };
      expect(formatMessagePreview(msg)).toBe('[Agent]: Hello');
    });

    it('truncates long messages', () => {
      const longBody = 'A'.repeat(100);
      const msg = { from: 'Agent', timestamp: '2025-01-01', body: longBody };
      const result = formatMessagePreview(msg);
      expect(result).toBe('[Agent]: ' + 'A'.repeat(50) + '...');
    });

    it('respects custom maxLength', () => {
      const msg = { from: 'Agent', timestamp: '2025-01-01', body: 'Hello World' };
      const result = formatMessagePreview(msg, 5);
      expect(result).toBe('[Agent]: Hello...');
    });
  });

  describe('buildBlockReason', () => {
    it('builds reason with message previews', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      const content = `## Message from AgentA | 2025-01-01T10:00:00Z
First message

## Message from AgentB | 2025-01-02T12:00:00Z
Second message`;
      fs.writeFileSync(inboxPath, content);

      const reason = buildBlockReason(inboxPath, 2);

      expect(reason).toContain('2 unread relay message(s)');
      expect(reason).toContain(inboxPath);
      expect(reason).toContain('[AgentA]: First message');
      expect(reason).toContain('[AgentB]: Second message');
      expect(reason).toContain('read the inbox file');
    });

    it('indicates more messages when > 3', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      const content = `## Message from A | 2025-01-01T10:00:00Z
msg1

## Message from B | 2025-01-01T10:01:00Z
msg2

## Message from C | 2025-01-01T10:02:00Z
msg3

## Message from D | 2025-01-01T10:03:00Z
msg4

## Message from E | 2025-01-01T10:04:00Z
msg5`;
      fs.writeFileSync(inboxPath, content);

      const reason = buildBlockReason(inboxPath, 5);

      expect(reason).toContain('5 unread relay message(s)');
      expect(reason).toContain('... and 2 more');
    });
  });
});
