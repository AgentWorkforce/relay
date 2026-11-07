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

const FLEET_REVIEWER_PROVIDERS = Object.freeze({
  'cheap-supervisor': 'opencode',
  'analysis-repair': 'codex',
  'final-claude-review': 'claude',
  'final-codex-review': 'codex',
});

const DIAGNOSIS_AGENT_PROVIDERS = Object.freeze({
  lead: 'claude',
  'cloud-specialist': 'opencode',
  'relayfile-specialist': 'opencode',
  'data-plane-specialist': 'opencode',
  'claude-reviewer': 'claude',
  'claude-fixer': 'claude',
  'codex-reviewer': 'codex',
  'codex-fixer': 'codex',
  'fresh-claude-signoff': 'claude',
  'fresh-codex-signoff': 'codex',
});

const CLEANROOM_INFRASTRUCTURE_HOSTS = Object.freeze([
  'agentrelay.com:443',
  'api.github.com:443',
  'github.com:443',
  'codeload.github.com:443',
  'registry.npmjs.org:443',
  'crates.io:443',
  'index.crates.io:443',
  'static.crates.io:443',
  'pypi.org:443',
  'files.pythonhosted.org:443',
  'localhost:*',
  '127.0.0.1:*',
  '[::1]:*',
]);

const HOSTNAME =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function validateStrictHostPort(value) {
  if (typeof value !== 'string' || value.length > 255 || /[\s\\/@?#]/u.test(value)) {
    throw new Error('cloudHost must be a strict host:port value');
  }
  let host;
  let port;
  if (value.startsWith('[')) {
    const closing = value.indexOf(']');
    if (closing < 2 || value[closing + 1] !== ':')
      throw new Error('cloudHost must be a strict host:port value');
    host = value.slice(1, closing);
    port = value.slice(closing + 2);
    if (!/^[0-9A-Fa-f:]+$/u.test(host)) throw new Error('cloudHost IPv6 host is invalid');
  } else {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || separator === value.length - 1 || value.indexOf(':') !== separator) {
      throw new Error('cloudHost must be a strict host:port value');
    }
    host = value.slice(0, separator);
    port = value.slice(separator + 1);
    if (!HOSTNAME.test(host) && !IPV4.test(host)) throw new Error('cloudHost host is invalid');
  }
  if (!/^(?:[1-9]\d{0,4})$/u.test(port) || Number(port) > 65_535) {
    throw new Error('cloudHost port must be between 1 and 65535');
  }
  return value;
}

function modelTransportNetwork(provider, label) {
  const allow = MODEL_TRANSPORT_HOSTS[provider];
  if (!allow) throw new Error(`unknown ${label} model provider ${provider ?? '<missing>'}`);
  return { allow: [...allow], deny: ['*'] };
}

export function preflightPermissions(agentName) {
  const provider = agentName.startsWith('preflight-') ? agentName.slice('preflight-'.length) : '';
  return {
    description: 'Allow only the selected harness model transport for the allocation preflight.',
    why: 'The preflight proves the exact model is reachable before any Daytona resource is allocated.',
    access: 'restricted',
    inherit: false,
    files: { read: [], write: [], deny: ['**'] },
    network: modelTransportNetwork(provider, 'Fleet preflight'),
    exec: [],
  };
}

export function fleetReviewerNetwork(agentName) {
  return modelTransportNetwork(FLEET_REVIEWER_PROVIDERS[agentName], `Fleet reviewer ${agentName}`);
}

export function diagnosisAgentNetwork(agentName) {
  return modelTransportNetwork(DIAGNOSIS_AGENT_PROVIDERS[agentName], `diagnosis agent ${agentName}`);
}

export function cleanroomReviewNetwork(role, cloudHost) {
  const provider =
    role.startsWith('claude') || role === 'final-claude-signoff'
      ? 'claude'
      : role.startsWith('codex') || role === 'final-codex-signoff'
        ? 'codex'
        : role === 'supervisor' || role.startsWith('opencode')
          ? 'opencode'
          : undefined;
  const allow = [...modelTransportNetwork(provider, `cleanroom reviewer ${role}`).allow];
  if (cloudHost) allow.unshift(validateStrictHostPort(cloudHost));
  return { allow: [...new Set(allow)], deny: ['*'] };
}

export function cleanroomLaneNetwork() {
  return {
    allow: [...new Set([...CLEANROOM_INFRASTRUCTURE_HOSTS, ...MODEL_TRANSPORT_HOSTS.codex])],
    deny: ['*'],
  };
}

function cleanroomLaneEvidencePath(nonce, lane) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(nonce) || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(lane)) {
    throw new Error('cleanroom lane identity is invalid');
  }
  return `.workflow-artifacts/verify-cleanroom/${nonce}/lanes/${lane}/evidence.json`;
}

function cleanroomLaneMountAnchorPath(nonce, lane) {
  return cleanroomLaneEvidencePath(nonce, lane).replace(/evidence\.json$/u, '.mount-write-anchor');
}

export function cleanroomLaneEvidenceScopes(nonce, lane) {
  const evidencePath = cleanroomLaneEvidencePath(nonce, lane);
  return [`relayfile:fs:read:/${evidencePath}`, `relayfile:fs:write:/${evidencePath}`];
}

export function cleanroomLaneWritePaths(nonce, lane) {
  const evidencePath = cleanroomLaneEvidencePath(nonce, lane);
  const laneRoot = `.workflow-artifacts/verify-cleanroom/${nonce}/lanes/${lane}/workspace`;
  return [
    `${laneRoot}/node_modules/**`,
    `${laneRoot}/target/**`,
    `${laneRoot}/packages/sdk-swift/.build/**`,
    `${laneRoot}/packages/*/dist/**`,
    `${laneRoot}/packages/*/node_modules/**`,
    `${laneRoot}/plugins/*/dist/**`,
    `${laneRoot}/plugins/*/node_modules/**`,
    `${laneRoot}/tests/integration/broker/dist/**`,
    cleanroomLaneMountAnchorPath(nonce, lane),
    evidencePath,
  ];
}
