export interface NavItem {
  title: string;
  slug: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const docsNav: NavGroup[] = [
  {
    title: 'Start',
    items: [
      { title: 'Introduction', slug: 'introduction' },
      { title: 'Quickstart', slug: 'quickstart' },
      { title: 'Workspaces', slug: 'workspaces' },
    ],
  },
  {
    title: 'Messaging',
    items: [
      { title: 'Overview', slug: 'messaging' },
      { title: 'Sending messages', slug: 'sending-messages' },
      { title: 'Channels', slug: 'channels' },
      { title: 'DMs and group DMs', slug: 'dms' },
      { title: 'Threads', slug: 'threads' },
      { title: 'Emoji reactions', slug: 'emoji-reactions' },
    ],
  },
  {
    title: 'Automation',
    items: [
      { title: 'Actions', slug: 'actions' },
      { title: 'Event handlers', slug: 'event-handlers' },
      { title: 'Webhooks', slug: 'webhooks' },
    ],
  },
  {
    title: 'Delivery and sessions',
    items: [
      { title: 'Delivery', slug: 'delivery' },
      { title: 'Harnesses', slug: 'harnesses' },
      { title: 'Session capabilities', slug: 'session-capabilities' },
      { title: 'Harness driver package', slug: 'harness-driver' },
    ],
  },
  {
    title: 'Interfaces',
    items: [
      { title: 'TypeScript SDK', slug: 'typescript-sdk' },
      { title: 'Agent Relay MCP', slug: 'agent-relay-mcp' },
      { title: 'OpenClaw adapter', slug: 'reference-openclaw' },
    ],
  },
  {
    title: 'CLI',
    items: [
      { title: 'CLI', slug: 'cli-overview' },
      { title: 'CLI messaging', slug: 'cli-messaging' },
      { title: 'Agent management', slug: 'cli-agent-management' },
      { title: 'Broker lifecycle', slug: 'cli-broker-lifecycle' },
      { title: 'CLI reference', slug: 'reference-cli' },
    ],
  },
  {
    title: 'Reference',
    items: [{ title: 'Migration to version 8', slug: 'migration' }],
  },
];

/** All doc slugs for static generation + search. */
export const currentDocsSlugs = docsNav.flatMap((group) => group.items.map((item) => item.slug));

export const legacyDocsNav: NavGroup[] = [
  {
    title: 'Getting Started',
    items: [
      { title: 'Introduction', slug: 'introduction' },
      { title: 'Quickstart', slug: 'quickstart' },
    ],
  },
  {
    title: 'Basics',
    items: [
      { title: 'Spawning an agent', slug: 'spawning-an-agent' },
      { title: 'Harnesses', slug: 'harnesses' },
      { title: 'Sending messages', slug: 'sending-messages' },
      { title: 'Event handlers', slug: 'event-handlers' },
      { title: 'Channels', slug: 'channels' },
      { title: 'DMs', slug: 'dms' },
      { title: 'Threads', slug: 'threads' },
      { title: 'Emoji reactions', slug: 'emoji-reactions' },
      { title: 'File sharing', slug: 'file-sharing' },
      { title: 'Authentication', slug: 'authentication' },
      { title: 'Permissions', slug: 'permissions' },
      { title: 'Scheduling', slug: 'scheduling' },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { title: 'Cloud', slug: 'cloud' },
      { title: 'Workforce', slug: 'workforce' },
      { title: 'Proactive agents', slug: 'proactive-agents' },
    ],
  },
  {
    title: 'Tools',
    items: [
      { title: 'Agent Relay MCP', slug: 'agent-relay-mcp' },
      { title: 'Relay Dashboard', slug: 'relay-dashboard' },
      { title: 'Observer', slug: 'observer' },
    ],
  },
  {
    title: 'CLI',
    items: [
      { title: 'Overview', slug: 'cli-overview' },
      { title: 'Broker lifecycle', slug: 'cli-broker-lifecycle' },
      { title: 'Agent management', slug: 'cli-agent-management' },
      { title: 'Messaging', slug: 'cli-messaging' },
      { title: 'Cloud commands', slug: 'cli-cloud-commands' },
      { title: 'On the relay', slug: 'cli-on-the-relay' },
      { title: 'CLI reference', slug: 'reference-cli' },
      { title: 'Broker HTTP / WS API', slug: 'reference-broker-api' },
    ],
  },
  {
    title: 'SDKs',
    items: [
      { title: 'TypeScript SDK', slug: 'typescript-sdk' },
      { title: 'Python SDK', slug: 'python-sdk' },
      { title: 'React SDK', slug: 'react-sdk' },
      { title: 'Swift SDK', slug: 'swift-sdk' },
    ],
  },
  {
    title: 'Plugins',
    items: [{ title: 'Claude Code', slug: 'plugin-claude-code' }],
  },
  {
    title: 'Examples',
    items: [{ title: 'TypeScript Examples', slug: 'typescript-examples' }],
  },
];

const LEGACY_HIDDEN_SLUGS = [
  'communicate',
  'communicate-ai-sdk',
  'communicate-claude-sdk',
  'communicate-google-adk',
  'communicate-pi',
  'communicate-agno',
  'communicate-openai-agents',
  'communicate-swarms',
  'communicate-crewai',
  'doctor-orchestration-repros',
  'harness-runtime-config',
  'local-mode',
  'reference-openclaw',
];

export const legacyDocsSlugs = [
  ...legacyDocsNav.flatMap((group) => group.items.map((item) => item.slug)),
  ...LEGACY_HIDDEN_SLUGS,
];

/** Flat list of all doc slugs for static generation */
export function getAllDocSlugs(): string[] {
  return [...new Set(currentDocsSlugs)];
}

/** Flat list of all version 7.1.1 doc slugs for static generation */
export function getAllLegacyDocSlugs(): string[] {
  return [...new Set(legacyDocsSlugs)];
}
