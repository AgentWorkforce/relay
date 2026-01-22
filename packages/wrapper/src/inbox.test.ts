import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { InboxManager, DEFAULT_INBOX_DIR } from './inbox.js';

function makeTempDir(): string {
  const base = path.join(process.cwd(), '.tmp-wrapper-inbox-tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'inbox-'));
  return dir;
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('InboxManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) {
      cleanup(tempDir);
    }
  });

  describe('DEFAULT_INBOX_DIR', () => {
    it('has expected default value', () => {
      expect(DEFAULT_INBOX_DIR).toBe('/tmp/agent-relay');
    });
  });

  describe('constructor', () => {
    it('uses default inbox directory when not provided', () => {
      const manager = new InboxManager({ agentName: 'TestAgent' });
      expect(manager.getInboxPath()).toBe(
        path.join(DEFAULT_INBOX_DIR, 'TestAgent', 'inbox.md')
      );
    });

    it('uses custom inbox directory when provided', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      expect(manager.getInboxPath()).toBe(
        path.join(tempDir, 'TestAgent', 'inbox.md')
      );
    });
  });

  describe('init', () => {
    it('creates agent directory if it does not exist', () => {
      const manager = new InboxManager({
        agentName: 'NewAgent',
        inboxDir: tempDir,
      });
      manager.init();

      const agentDir = path.join(tempDir, 'NewAgent');
      expect(fs.existsSync(agentDir)).toBe(true);
    });

    it('creates empty inbox file', () => {
      const manager = new InboxManager({
        agentName: 'NewAgent',
        inboxDir: tempDir,
      });
      manager.init();

      const inboxPath = manager.getInboxPath();
      expect(fs.existsSync(inboxPath)).toBe(true);
      expect(fs.readFileSync(inboxPath, 'utf-8')).toBe('');
    });

    it('clears existing inbox on init', () => {
      const agentDir = path.join(tempDir, 'ExistingAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      const inboxPath = path.join(agentDir, 'inbox.md');
      fs.writeFileSync(inboxPath, 'Old content');

      const manager = new InboxManager({
        agentName: 'ExistingAgent',
        inboxDir: tempDir,
      });
      manager.init();

      expect(fs.readFileSync(inboxPath, 'utf-8')).toBe('');
    });
  });

  describe('getInboxPath', () => {
    it('returns correct path', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      expect(manager.getInboxPath()).toBe(
        path.join(tempDir, 'TestAgent', 'inbox.md')
      );
    });
  });

  describe('addMessage', () => {
    it('adds message to empty inbox with header', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      manager.init();

      manager.addMessage('SenderAgent', 'Hello World');

      const content = fs.readFileSync(manager.getInboxPath(), 'utf-8');
      expect(content).toContain('# 📬 INBOX');
      expect(content).toContain('## Message from SenderAgent |');
      expect(content).toContain('Hello World');
    });

    it('appends multiple messages', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      manager.init();

      manager.addMessage('Agent1', 'First message');
      manager.addMessage('Agent2', 'Second message');

      const content = fs.readFileSync(manager.getInboxPath(), 'utf-8');
      expect(content).toContain('## Message from Agent1 |');
      expect(content).toContain('First message');
      expect(content).toContain('## Message from Agent2 |');
      expect(content).toContain('Second message');
    });

    it('includes timestamp in ISO format', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      manager.init();

      manager.addMessage('Sender', 'Test');

      const content = fs.readFileSync(manager.getInboxPath(), 'utf-8');
      // Check timestamp is present (at least the date part)
      expect(content).toMatch(/## Message from Sender \| \d{4}-\d{2}-\d{2}/);
    });

    it('handles adding to non-existent inbox file', () => {
      const agentDir = path.join(tempDir, 'NoInit');
      fs.mkdirSync(agentDir, { recursive: true });

      const manager = new InboxManager({
        agentName: 'NoInit',
        inboxDir: tempDir,
      });
      // Don't call init()

      manager.addMessage('Sender', 'Message without init');

      const content = fs.readFileSync(manager.getInboxPath(), 'utf-8');
      expect(content).toContain('# 📬 INBOX');
      expect(content).toContain('Message without init');
    });
  });

  describe('clear', () => {
    it('clears inbox content', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      manager.init();
      manager.addMessage('Sender', 'Content to clear');

      manager.clear();

      expect(fs.readFileSync(manager.getInboxPath(), 'utf-8')).toBe('');
    });
  });

  describe('hasMessages', () => {
    it('returns false when inbox does not exist', () => {
      const manager = new InboxManager({
        agentName: 'NoExist',
        inboxDir: tempDir,
      });
      expect(manager.hasMessages()).toBe(false);
    });

    it('returns false when inbox is empty', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      manager.init();
      expect(manager.hasMessages()).toBe(false);
    });

    it('returns false when inbox has only header', () => {
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, 'inbox.md'),
        '# 📬 INBOX\n'
      );

      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      expect(manager.hasMessages()).toBe(false);
    });

    it('returns true when inbox has messages', () => {
      const manager = new InboxManager({
        agentName: 'TestAgent',
        inboxDir: tempDir,
      });
      manager.init();
      manager.addMessage('Sender', 'A message');

      expect(manager.hasMessages()).toBe(true);
    });
  });
});
