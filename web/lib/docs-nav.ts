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
      { title: 'Sending messages', slug: 'sending-messages' },
      { title: 'Event handlers', slug: 'event-handlers' },
      { title: 'Channels', slug: 'channels' },
      { title: 'DMs', slug: 'dms' },
      { title: 'Threads', slug: 'threads' },
      { title: 'Emoji reactions', slug: 'emoji-reactions' },
      { title: 'File sharing', slug: 'file-sharing' },
      { title: 'Authentication', slug: 'authentication' },
      { title: 'Scheduling', slug: 'scheduling' },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { title: 'Workflows', slug: 'reference-workflows' },
      { title: 'Cloud', slug: 'cloud' },
      { title: 'Workforce', slug: 'workforce' },
    ],
  },
  {
    title: 'CLI',
    items: [
      { title: 'Overview', slug: 'cli-overview' },
      { title: 'Broker lifecycle', slug: 'cli-broker-lifecycle' },
      { title: 'Agent management', slug: 'cli-agent-management' },
      { title: 'Messaging', slug: 'cli-messaging' },
      { title: 'Run workflows', slug: 'cli-workflows' },
      { title: 'Cloud commands', slug: 'cli-cloud-commands' },
      { title: 'On the relay', slug: 'cli-on-the-relay' },
    ],
  },
  {
    title: 'SDKs',
    items: [
      { title: 'TypeScript SDK', slug: 'reference-sdk' },
      { title: 'Python SDK', slug: 'reference-sdk-py' },
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

/** All doc slugs including hidden pages (for static generation + search) */
const ALL_SLUGS = [
  ...docsNav.flatMap((group) => group.items.map((item) => item.slug)),
  // Hidden from nav but still routable
  'communicate',
  'communicate-ai-sdk',
  'communicate-claude-sdk',
  'communicate-google-adk',
  'communicate-pi',
  'communicate-agno',
  'communicate-openai-agents',
  'communicate-swarms',
  'communicate-crewai',
  'reference-openclaw',
  'reference-workflows',
];

/** Flat list of all doc slugs for static generation */
export function getAllDocSlugs(): string[] {
  return [...new Set(ALL_SLUGS)];
}
