export const MODEL_TRANSPORT_HOSTS = Object.freeze({
  opencode: Object.freeze([
    'api.opencode.ai:443',
    'opencode.ai:443',
    'api.openrouter.ai:443',
    'openrouter.ai:443',
  ]),
  codex: Object.freeze(['api.openai.com:443', 'chatgpt.com:443', 'auth.openai.com:443']),
  claude: Object.freeze(['api.anthropic.com:443']),
});

export function preflightPermissions(agentName) {
  const provider = agentName.startsWith('preflight-') ? agentName.slice('preflight-'.length) : '';
  const allow = MODEL_TRANSPORT_HOSTS[provider];
  if (!allow) throw new Error(`unknown Fleet preflight provider ${provider}`);
  return {
    description: 'Allow only the selected harness model transport for the allocation preflight.',
    why: 'The preflight proves the exact model is reachable before any Daytona resource is allocated.',
    access: 'restricted',
    inherit: false,
    files: { read: [], write: [], deny: ['**'] },
    network: { allow: [...allow], deny: ['*'] },
    exec: [],
  };
}
