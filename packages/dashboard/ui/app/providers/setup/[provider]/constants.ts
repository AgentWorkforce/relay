/**
 * Provider configurations for setup
 */

export interface ProviderConfig {
  id: string;
  name: string;
  displayName: string;
  color: string;
  agentCommand: string;
}

export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  claude: {
    id: 'claude',
    name: 'anthropic',
    displayName: 'Claude',
    color: '#D97706',
    agentCommand: 'claude',
  },
  codex: {
    id: 'codex',
    name: 'openai',
    displayName: 'Codex',
    color: '#10A37F',
    agentCommand: 'codex',
  },
  cursor: {
    id: 'cursor',
    name: 'cursor',
    displayName: 'Cursor',
    color: '#7C3AED', // Purple for Cursor
    agentCommand: 'cursor',
  },
};
