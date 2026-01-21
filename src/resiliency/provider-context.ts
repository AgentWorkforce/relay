/**
 * Provider-Specific Context Injection
 *
 * Handles context persistence differently based on the AI provider:
 * - Claude: Uses hooks (PreToolUse, PostToolUse, Stop) to inject/save context
 * - Codex: Uses config settings for periodic context refresh
 * - Gemini: Uses system instruction updates
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';
import { ContextPersistence, getContextPersistence, Handoff } from './context-persistence.js';

const logger = createLogger('provider-context');

export type ProviderType = 'claude' | 'codex' | 'gemini' | 'cursor' | 'generic';

export interface ProviderContextConfig {
  provider: ProviderType;
  workingDir: string;
  agentName: string;
  task?: string;
}

export interface ClaudeHooksConfig {
  hooksDir: string; // .claude/hooks/
  onPreToolUse?: boolean; // Inject context before tool use
  onStop?: boolean; // Save context on stop
  contextFile?: string; // Path to inject (CLAUDE.md or custom)
}

export interface CodexContextConfig {
  configPath: string; // .codex/config.json
  contextRefreshInterval?: number; // ms between context updates
  systemPromptPath?: string; // Path to system prompt file
}

/**
 * Base class for provider-specific context handling
 */
abstract class ProviderContextHandler {
  protected persistence: ContextPersistence;
  protected config: ProviderContextConfig;

  constructor(config: ProviderContextConfig) {
    this.config = config;
    this.persistence = getContextPersistence(
      path.join(config.workingDir, '.agent-relay', 'context')
    );
  }

  abstract setup(): Promise<void>;
  abstract injectContext(handoff: Handoff): Promise<void>;
  abstract saveContext(): Promise<void>;
  abstract cleanup(): Promise<void>;

  protected getState() {
    return this.persistence.getState(this.config.agentName);
  }
}

/**
 * Claude Context Handler using Hooks
 *
 * Creates hooks that:
 * - Pre-tool: Inject resumption context before critical operations
 * - Stop: Save state to ledger on session end
 */
export class ClaudeContextHandler extends ProviderContextHandler {
  private hooksConfig: ClaudeHooksConfig;

  constructor(config: ProviderContextConfig, hooksConfig?: Partial<ClaudeHooksConfig>) {
    super(config);
    this.hooksConfig = {
      hooksDir: path.join(config.workingDir, '.claude', 'hooks'),
      onPreToolUse: true,
      onStop: true,
      contextFile: path.join(config.workingDir, 'CLAUDE.md'),
      ...hooksConfig,
    };
  }

  async setup(): Promise<void> {
    // Ensure hooks directory exists
    if (!fs.existsSync(this.hooksConfig.hooksDir)) {
      fs.mkdirSync(this.hooksConfig.hooksDir, { recursive: true });
    }

    // Create or update settings.json with hook configuration
    const settingsPath = path.join(this.config.workingDir, '.claude', 'settings.json');
    let settings: Record<string, unknown> = {};

    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        // Start fresh if invalid
      }
    }

    // Configure hooks
    const hooks: Record<string, unknown[]> = (settings.hooks as Record<string, unknown[]>) || {};

    if (this.hooksConfig.onStop) {
      // Stop hook to save context
      const stopHookScript = this.createStopHookScript();
      const stopHookPath = path.join(this.hooksConfig.hooksDir, 'save-context.sh');
      fs.writeFileSync(stopHookPath, stopHookScript, { mode: 0o755 });

      hooks.Stop = hooks.Stop || [];
      const stopHookEntry = {
        matcher: '',
        hooks: [{ type: 'command', command: stopHookPath }],
      };
      // Only add if not already present
      if (!hooks.Stop.some((h: unknown) => {
        const entry = h as { hooks?: Array<{ command?: string }> };
        return entry.hooks?.[0]?.command === stopHookPath;
      })) {
        hooks.Stop.push(stopHookEntry);
      }
    }

    settings.hooks = hooks;

    // Write updated settings
    const settingsDir = path.dirname(settingsPath);
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    logger.info('Claude hooks configured', {
      hooksDir: this.hooksConfig.hooksDir,
      onStop: this.hooksConfig.onStop,
    });
  }

  async injectContext(handoff: Handoff): Promise<void> {
    if (!this.hooksConfig.contextFile) return;

    // Read existing CLAUDE.md
    let existingContent = '';
    if (fs.existsSync(this.hooksConfig.contextFile)) {
      existingContent = fs.readFileSync(this.hooksConfig.contextFile, 'utf8');
    }

    // Generate resumption context
    const resumptionContext = this.persistence.generateResumptionContext(this.config.agentName);

    if (!resumptionContext) return;

    // Check if we already have resumption context
    const marker = '<!-- AGENT_RESUMPTION_CONTEXT -->';
    const endMarker = '<!-- END_AGENT_RESUMPTION_CONTEXT -->';

    let newContent: string;
    if (existingContent.includes(marker)) {
      // Replace existing context
      const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}`, 'g');
      newContent = existingContent.replace(
        regex,
        `${marker}\n${resumptionContext}\n${endMarker}`
      );
    } else {
      // Prepend context
      newContent = `${marker}\n${resumptionContext}\n${endMarker}\n\n${existingContent}`;
    }

    fs.writeFileSync(this.hooksConfig.contextFile, newContent);

    logger.info('Injected resumption context into CLAUDE.md', {
      agent: this.config.agentName,
      handoffId: handoff.fromAgent,
    });
  }

  async saveContext(): Promise<void> {
    this.persistence.checkpoint(this.config.agentName);
    logger.info('Saved Claude context checkpoint', { agent: this.config.agentName });
  }

  async cleanup(): Promise<void> {
    // Optionally remove the resumption context from CLAUDE.md
    if (this.hooksConfig.contextFile && fs.existsSync(this.hooksConfig.contextFile)) {
      const content = fs.readFileSync(this.hooksConfig.contextFile, 'utf8');
      const marker = '<!-- AGENT_RESUMPTION_CONTEXT -->';
      const endMarker = '<!-- END_AGENT_RESUMPTION_CONTEXT -->';
      const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}\\n*`, 'g');
      const cleaned = content.replace(regex, '');
      fs.writeFileSync(this.hooksConfig.contextFile, cleaned);
    }
  }

  private createStopHookScript(): string {
    const contextDir = path.join(this.config.workingDir, '.agent-relay', 'context');
    return `#!/bin/bash
# Claude Code Stop Hook - Save agent context
# Generated by agent-relay

AGENT_NAME="${this.config.agentName}"
CONTEXT_DIR="${contextDir}"

# Read hook input from stdin
read -r INPUT

# Save checkpoint marker
mkdir -p "$CONTEXT_DIR/ledgers"
echo '{"event":"stop","timestamp":"'$(date -Iseconds)'","agent":"'$AGENT_NAME'"}' >> "$CONTEXT_DIR/ledgers/events.jsonl"

# Exit successfully (don't block stop)
exit 0
`;
  }
}

/**
 * Codex Context Handler using Config
 *
 * Uses Codex's configuration for:
 * - Periodic context refresh via system prompt updates
 * - History file for context continuity
 */
export class CodexContextHandler extends ProviderContextHandler {
  private codexConfig: CodexContextConfig;
  private refreshInterval?: ReturnType<typeof setInterval>;

  constructor(config: ProviderContextConfig, codexConfig?: Partial<CodexContextConfig>) {
    super(config);
    this.codexConfig = {
      configPath: path.join(config.workingDir, '.codex', 'config.json'),
      contextRefreshInterval: 60000, // 1 minute default
      systemPromptPath: path.join(config.workingDir, '.codex', 'system-prompt.md'),
      ...codexConfig,
    };
  }

  async setup(): Promise<void> {
    const configDir = path.dirname(this.codexConfig.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Read or create config
    let config: Record<string, unknown> = {};
    if (fs.existsSync(this.codexConfig.configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(this.codexConfig.configPath, 'utf8'));
      } catch {
        // Start fresh
      }
    }

    // Set up context-aware configuration
    config.history = config.history || {};
    (config.history as Record<string, unknown>).save_history = true;
    (config.history as Record<string, unknown>).max_history_size = 1000;

    // Disable Codex auto-update checks to keep container-stable version
    (config as Record<string, unknown>).check_for_updates = false;

    // Point to our system prompt if using custom context
    if (this.codexConfig.systemPromptPath) {
      config.system_prompt_file = this.codexConfig.systemPromptPath;
    }

    fs.writeFileSync(this.codexConfig.configPath, JSON.stringify(config, null, 2));

    logger.info('Codex config configured', {
      configPath: this.codexConfig.configPath,
      refreshInterval: this.codexConfig.contextRefreshInterval,
    });
  }

  async injectContext(_handoff: Handoff): Promise<void> {
    if (!this.codexConfig.systemPromptPath) return;

    // Generate resumption context
    const resumptionContext = this.persistence.generateResumptionContext(this.config.agentName);

    if (!resumptionContext) return;

    // Read existing system prompt
    let existingPrompt = '';
    if (fs.existsSync(this.codexConfig.systemPromptPath)) {
      existingPrompt = fs.readFileSync(this.codexConfig.systemPromptPath, 'utf8');
    }

    // Add/update resumption context
    const marker = '<!-- AGENT_RESUMPTION_CONTEXT -->';
    const endMarker = '<!-- END_AGENT_RESUMPTION_CONTEXT -->';

    let newPrompt: string;
    if (existingPrompt.includes(marker)) {
      const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}`, 'g');
      newPrompt = existingPrompt.replace(regex, `${marker}\n${resumptionContext}\n${endMarker}`);
    } else {
      newPrompt = `${marker}\n${resumptionContext}\n${endMarker}\n\n${existingPrompt}`;
    }

    fs.writeFileSync(this.codexConfig.systemPromptPath, newPrompt);

    logger.info('Injected resumption context into Codex system prompt', {
      agent: this.config.agentName,
    });
  }

  async saveContext(): Promise<void> {
    this.persistence.checkpoint(this.config.agentName);
    logger.info('Saved Codex context checkpoint', { agent: this.config.agentName });
  }

  /**
   * Start periodic context refresh
   */
  startPeriodicRefresh(): void {
    if (this.refreshInterval) return;

    this.refreshInterval = setInterval(async () => {
      const handoff = this.persistence.createHandoff(this.config.agentName);
      await this.injectContext(handoff);
    }, this.codexConfig.contextRefreshInterval);

    logger.info('Started periodic context refresh for Codex', {
      interval: this.codexConfig.contextRefreshInterval,
    });
  }

  stopPeriodicRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  async cleanup(): Promise<void> {
    this.stopPeriodicRefresh();

    if (this.codexConfig.systemPromptPath && fs.existsSync(this.codexConfig.systemPromptPath)) {
      const content = fs.readFileSync(this.codexConfig.systemPromptPath, 'utf8');
      const marker = '<!-- AGENT_RESUMPTION_CONTEXT -->';
      const endMarker = '<!-- END_AGENT_RESUMPTION_CONTEXT -->';
      const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}\\n*`, 'g');
      const cleaned = content.replace(regex, '');
      fs.writeFileSync(this.codexConfig.systemPromptPath, cleaned);
    }
  }
}

/**
 * Gemini Context Handler
 *
 * Uses system instruction file for context injection
 */
export class GeminiContextHandler extends ProviderContextHandler {
  private systemInstructionPath: string;

  constructor(config: ProviderContextConfig) {
    super(config);
    this.systemInstructionPath = path.join(
      config.workingDir,
      '.gemini',
      'system-instruction.md'
    );
  }

  async setup(): Promise<void> {
    const dir = path.dirname(this.systemInstructionPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    logger.info('Gemini context handler configured', {
      systemInstructionPath: this.systemInstructionPath,
    });
  }

  async injectContext(_handoff: Handoff): Promise<void> {
    const resumptionContext = this.persistence.generateResumptionContext(this.config.agentName);

    if (!resumptionContext) return;

    let existingContent = '';
    if (fs.existsSync(this.systemInstructionPath)) {
      existingContent = fs.readFileSync(this.systemInstructionPath, 'utf8');
    }

    const marker = '<!-- AGENT_RESUMPTION_CONTEXT -->';
    const endMarker = '<!-- END_AGENT_RESUMPTION_CONTEXT -->';

    let newContent: string;
    if (existingContent.includes(marker)) {
      const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}`, 'g');
      newContent = existingContent.replace(regex, `${marker}\n${resumptionContext}\n${endMarker}`);
    } else {
      newContent = `${marker}\n${resumptionContext}\n${endMarker}\n\n${existingContent}`;
    }

    fs.writeFileSync(this.systemInstructionPath, newContent);

    logger.info('Injected resumption context for Gemini', { agent: this.config.agentName });
  }

  async saveContext(): Promise<void> {
    this.persistence.checkpoint(this.config.agentName);
  }

  async cleanup(): Promise<void> {
    if (fs.existsSync(this.systemInstructionPath)) {
      const content = fs.readFileSync(this.systemInstructionPath, 'utf8');
      const marker = '<!-- AGENT_RESUMPTION_CONTEXT -->';
      const endMarker = '<!-- END_AGENT_RESUMPTION_CONTEXT -->';
      const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}\\n*`, 'g');
      const cleaned = content.replace(regex, '');
      fs.writeFileSync(this.systemInstructionPath, cleaned);
    }
  }
}

/**
 * Factory function to create the appropriate context handler
 */
export function createContextHandler(
  config: ProviderContextConfig,
  providerOptions?: Record<string, unknown>
): ProviderContextHandler {
  switch (config.provider) {
    case 'claude':
      return new ClaudeContextHandler(config, providerOptions as Partial<ClaudeHooksConfig>);
    case 'codex':
      return new CodexContextHandler(config, providerOptions as Partial<CodexContextConfig>);
    case 'gemini':
      return new GeminiContextHandler(config);
    default:
      // Generic handler - use Claude-style CLAUDE.md injection
      return new ClaudeContextHandler(config, {
        contextFile: path.join(config.workingDir, 'AGENT_CONTEXT.md'),
      });
  }
}

/**
 * Detect provider from CLI command
 */
export function detectProvider(cli: string): ProviderType {
  const cmd = cli.toLowerCase();
  if (cmd.includes('claude')) return 'claude';
  if (cmd.includes('codex')) return 'codex';
  if (cmd.includes('gemini')) return 'gemini';
  return 'generic';
}
