/**
 * Handoff Store
 *
 * Persists cross-session handoffs as markdown files.
 * Organized by agent, with timestamps in filenames.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Handoff, HandoffTrigger, Decision, FileRef } from './types.js';

export class HandoffStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /**
   * Ensure the handoffs directory exists
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  /**
   * Generate a unique handoff ID
   */
  private generateId(): string {
    return `ho_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Get the directory path for an agent's handoffs
   */
  private getAgentDir(agentName: string): string {
    const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.basePath, safeName);
  }

  /**
   * Generate a filename for a handoff
   */
  private generateFilename(handoff: Handoff): string {
    const date = handoff.createdAt.toISOString().split('T')[0];
    const taskSlug = handoff.taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
      .replace(/-+$/, '');
    return `${date}-${taskSlug || 'handoff'}-${handoff.id.slice(-6)}.md`;
  }

  /**
   * Convert a handoff to markdown format
   */
  private toMarkdown(handoff: Handoff): string {
    const lines: string[] = [];

    // YAML frontmatter
    lines.push('---');
    lines.push(`id: ${handoff.id}`);
    lines.push(`agent: ${handoff.agentName}`);
    lines.push(`cli: ${handoff.cli}`);
    lines.push(`created: ${handoff.createdAt.toISOString()}`);
    lines.push(`trigger: ${handoff.triggerReason}`);
    if (handoff.trajectoryId) {
      lines.push(`trajectoryId: ${handoff.trajectoryId}`);
    }
    if (handoff.pderoPhase) {
      lines.push(`pderoPhase: ${handoff.pderoPhase}`);
    }
    if (handoff.confidence !== undefined) {
      lines.push(`confidence: ${handoff.confidence}`);
    }
    if (handoff.relatedHandoffs.length > 0) {
      lines.push(`relatedHandoffs:`);
      for (const id of handoff.relatedHandoffs) {
        lines.push(`  - ${id}`);
      }
    }
    lines.push('---');
    lines.push('');

    // Title
    lines.push(`# ${handoff.taskDescription || 'Handoff'}`);
    lines.push('');

    // Summary
    if (handoff.summary) {
      lines.push('## Summary');
      lines.push('');
      lines.push(handoff.summary);
      lines.push('');
    }

    // Completed work
    if (handoff.completedWork.length > 0) {
      lines.push('## Completed');
      lines.push('');
      for (const item of handoff.completedWork) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }

    // Next steps
    if (handoff.nextSteps.length > 0) {
      lines.push('## Next Steps');
      lines.push('');
      for (const item of handoff.nextSteps) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }

    // Decisions
    if (handoff.decisions.length > 0) {
      lines.push('## Key Decisions');
      lines.push('');
      for (const decision of handoff.decisions) {
        lines.push(`### ${decision.decision}`);
        if (decision.reasoning) {
          lines.push('');
          lines.push(`**Reasoning:** ${decision.reasoning}`);
        }
        if (decision.alternatives && decision.alternatives.length > 0) {
          lines.push('');
          lines.push('**Alternatives considered:**');
          for (const alt of decision.alternatives) {
            lines.push(`- ${alt}`);
          }
        }
        if (decision.confidence !== undefined) {
          lines.push('');
          lines.push(`**Confidence:** ${Math.round(decision.confidence * 100)}%`);
        }
        lines.push('');
      }
    }

    // File references
    if (handoff.fileReferences.length > 0) {
      lines.push('## Files');
      lines.push('');
      for (const file of handoff.fileReferences) {
        let line = `- \`${file.path}\``;
        if (file.lines) {
          line += `:${file.lines[0]}-${file.lines[1]}`;
        }
        if (file.description) {
          line += ` - ${file.description}`;
        }
        lines.push(line);
      }
      lines.push('');
    }

    // Learnings
    if (handoff.learnings && handoff.learnings.length > 0) {
      lines.push('## Learnings');
      lines.push('');
      for (const learning of handoff.learnings) {
        lines.push(`- ${learning}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Parse a markdown file back to a Handoff object
   */
  private fromMarkdown(content: string, _filename: string): Handoff {
    const handoff: Handoff = {
      id: '',
      agentName: '',
      cli: 'unknown',
      summary: '',
      taskDescription: '',
      completedWork: [],
      nextSteps: [],
      fileReferences: [],
      decisions: [],
      relatedHandoffs: [],
      createdAt: new Date(),
      triggerReason: 'manual',
    };

    // Parse YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const lines = frontmatter.split('\n');

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex === -1) continue;

        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();

        switch (key) {
          case 'id':
            handoff.id = value;
            break;
          case 'agent':
            handoff.agentName = value;
            break;
          case 'cli':
            handoff.cli = value;
            break;
          case 'created':
            handoff.createdAt = new Date(value);
            break;
          case 'trigger': {
            const validTriggers: HandoffTrigger[] = ['manual', 'trajectory_complete', 'context_limit', 'auto_restart', 'crash', 'session_end'];
            if (validTriggers.includes(value as HandoffTrigger)) {
              handoff.triggerReason = value as HandoffTrigger;
            }
            break;
          }
          case 'trajectoryId':
            handoff.trajectoryId = value;
            break;
          case 'pderoPhase': {
            const validPhases = ['plan', 'design', 'execute', 'review', 'observe'];
            if (validPhases.includes(value)) {
              handoff.pderoPhase = value as 'plan' | 'design' | 'execute' | 'review' | 'observe';
            }
            break;
          }
          case 'confidence': {
            const conf = parseFloat(value);
            if (!isNaN(conf)) {
              handoff.confidence = Math.max(0, Math.min(1, conf));
            }
            break;
          }
        }
      }

      // Parse relatedHandoffs array
      const relatedMatch = frontmatter.match(/relatedHandoffs:\n((?:\s+-\s+\S+\n?)+)/);
      if (relatedMatch) {
        handoff.relatedHandoffs = relatedMatch[1]
          .split('\n')
          .map((l) => l.replace(/^\s+-\s+/, '').trim())
          .filter(Boolean);
      }
    }

    // Parse body
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '');

    // Extract title
    const titleMatch = body.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      handoff.taskDescription = titleMatch[1];
    }

    // Extract sections
    const sections = body.split(/^##\s+/m).slice(1);

    for (const section of sections) {
      const [header, ...contentLines] = section.split('\n');
      const sectionContent = contentLines.join('\n').trim();

      switch (header.trim().toLowerCase()) {
        case 'summary':
          handoff.summary = sectionContent;
          break;
        case 'completed':
          handoff.completedWork = this.parseListItems(sectionContent);
          break;
        case 'next steps':
          handoff.nextSteps = this.parseListItems(sectionContent);
          break;
        case 'files':
          handoff.fileReferences = this.parseFileRefs(sectionContent);
          break;
        case 'learnings':
          handoff.learnings = this.parseListItems(sectionContent);
          break;
        case 'key decisions':
          handoff.decisions = this.parseDecisions(sectionContent);
          break;
      }
    }

    return handoff;
  }

  private parseListItems(content: string): string[] {
    return content
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim());
  }

  private parseFileRefs(content: string): FileRef[] {
    return content
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => {
        const match = l.match(/^-\s+`([^`]+)`(?::(\d+)-(\d+))?(?:\s+-\s+(.+))?$/);
        if (!match) return null;

        const ref: FileRef = { path: match[1] };
        if (match[2] && match[3]) {
          const startLine = parseInt(match[2], 10);
          const endLine = parseInt(match[3], 10);
          // Only set lines if both are valid numbers
          if (!isNaN(startLine) && !isNaN(endLine)) {
            ref.lines = [startLine, endLine];
          }
        }
        if (match[4]) {
          ref.description = match[4];
        }
        return ref;
      })
      .filter((r): r is FileRef => r !== null);
  }

  private parseDecisions(content: string): Decision[] {
    const decisions: Decision[] = [];
    const decisionBlocks = content.split(/^###\s+/m).slice(1);

    for (const block of decisionBlocks) {
      const [decisionText, ...rest] = block.split('\n');
      const blockContent = rest.join('\n');

      const decision: Decision = {
        decision: decisionText.trim(),
        timestamp: new Date(),
      };

      const reasoningMatch = blockContent.match(/\*\*Reasoning:\*\*\s*(.+)/);
      if (reasoningMatch) {
        decision.reasoning = reasoningMatch[1];
      }

      const confidenceMatch = blockContent.match(/\*\*Confidence:\*\*\s*(\d+)%/);
      if (confidenceMatch) {
        const conf = parseInt(confidenceMatch[1], 10) / 100;
        if (!isNaN(conf)) {
          decision.confidence = Math.max(0, Math.min(1, conf));
        }
      }

      decisions.push(decision);
    }

    return decisions;
  }

  /**
   * Save a handoff
   */
  async save(handoff: Handoff): Promise<string> {
    // Ensure ID exists
    if (!handoff.id) {
      handoff.id = this.generateId();
    }

    // Ensure createdAt exists
    if (!handoff.createdAt) {
      handoff.createdAt = new Date();
    }

    const agentDir = this.getAgentDir(handoff.agentName);
    await fs.mkdir(agentDir, { recursive: true });

    const filename = this.generateFilename(handoff);
    const filePath = path.join(agentDir, filename);
    const markdown = this.toMarkdown(handoff);

    await fs.writeFile(filePath, markdown, 'utf-8');

    return handoff.id;
  }

  /**
   * Load a handoff by ID
   */
  async loadById(handoffId: string): Promise<Handoff | null> {
    // Search through all agent directories
    try {
      const agents = await fs.readdir(this.basePath);

      for (const agent of agents) {
        const agentDir = path.join(this.basePath, agent);
        const stat = await fs.stat(agentDir);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(agentDir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          if (!file.includes(handoffId.slice(-6))) continue;

          const content = await fs.readFile(path.join(agentDir, file), 'utf-8');
          const handoff = this.fromMarkdown(content, file);
          if (handoff.id === handoffId) {
            return handoff;
          }
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    return null;
  }

  /**
   * Get the latest handoff for an agent
   */
  async getLatest(agentName: string): Promise<Handoff | null> {
    const handoffs = await this.listForAgent(agentName, 1);
    return handoffs[0] || null;
  }

  /**
   * List handoffs for an agent (sorted by date, newest first)
   */
  async listForAgent(agentName: string, limit?: number): Promise<Handoff[]> {
    const agentDir = this.getAgentDir(agentName);

    try {
      const files = await fs.readdir(agentDir);
      const mdFiles = files.filter((f: string) => f.endsWith('.md')).sort().reverse();

      const handoffs: Handoff[] = [];
      const filesToRead = limit ? mdFiles.slice(0, limit) : mdFiles;

      for (const file of filesToRead) {
        const content = await fs.readFile(path.join(agentDir, file), 'utf-8');
        handoffs.push(this.fromMarkdown(content, file));
      }

      return handoffs;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * List all agents with handoffs
   */
  async listAgents(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.basePath, { withFileTypes: true });
      return entries.filter((e: import('node:fs').Dirent) => e.isDirectory()).map((e: import('node:fs').Dirent) => e.name);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Count handoffs for an agent
   */
  async countForAgent(agentName: string): Promise<number> {
    const agentDir = this.getAgentDir(agentName);

    try {
      const files = await fs.readdir(agentDir);
      return files.filter((f: string) => f.endsWith('.md')).length;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Delete a handoff by ID
   */
  async delete(handoffId: string): Promise<boolean> {
    // Find and delete the handoff file
    try {
      const agents = await fs.readdir(this.basePath);

      for (const agent of agents) {
        const agentDir = path.join(this.basePath, agent);
        const stat = await fs.stat(agentDir);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(agentDir);
        for (const file of files) {
          if (!file.endsWith('.md')) continue;
          if (!file.includes(handoffId.slice(-6))) continue;

          const content = await fs.readFile(path.join(agentDir, file), 'utf-8');
          const handoff = this.fromMarkdown(content, file);
          if (handoff.id === handoffId) {
            await fs.unlink(path.join(agentDir, file));
            return true;
          }
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }

    return false;
  }
}
