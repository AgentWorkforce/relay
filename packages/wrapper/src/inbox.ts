/**
 * File-based Inbox Manager
 * Writes incoming messages to a file that the CLI agent reads itself.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_INBOX_DIR = '/tmp/agent-relay';

export interface InboxConfig {
  agentName: string;
  inboxDir: string;
}

export class InboxManager {
  private config: InboxConfig;
  private inboxPath: string;

  constructor(config: Partial<InboxConfig> & { agentName: string }) {
    this.config = {
      inboxDir: DEFAULT_INBOX_DIR,
      ...config,
    };
    this.inboxPath = path.join(this.config.inboxDir, this.config.agentName, 'inbox.md');
  }

  /**
   * Initialize inbox directory and file.
   */
  init(): void {
    const dir = path.dirname(this.inboxPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Start with empty inbox
    this.clear();
  }

  /**
   * Get the inbox file path (for telling the agent where to read).
   */
  getInboxPath(): string {
    return this.inboxPath;
  }

  /**
   * Add a message to the inbox.
   */
  addMessage(from: string, body: string): void {
    const timestamp = new Date().toISOString();
    const entry = `\n## Message from ${from} | ${timestamp}\n${body}\n`;

    // Read existing content
    let content = '';
    if (fs.existsSync(this.inboxPath)) {
      content = fs.readFileSync(this.inboxPath, 'utf-8');
    }

    // If empty, add header
    if (!content.trim()) {
      content = `# 📬 INBOX - CHECK AND RESPOND TO ALL MESSAGES\n`;
    }

    // Append new message
    content += entry;

    // Atomic write (write to temp, then rename)
    const tmpPath = `${this.inboxPath}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, this.inboxPath);
  }

  /**
   * Clear the inbox.
   */
  clear(): void {
    fs.writeFileSync(this.inboxPath, '', 'utf-8');
  }

  /**
   * Check if inbox has messages.
   */
  hasMessages(): boolean {
    if (!fs.existsSync(this.inboxPath)) return false;
    const content = fs.readFileSync(this.inboxPath, 'utf-8');
    return content.includes('## Message from');
  }
}
