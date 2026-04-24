export interface NavItem {
  title: string;
  slug: string;
  /**
   * Optional nested items rendered as an indented sub-list beneath this
   * item. Used to group related pages (e.g. all messaging primitives under
   * "Message") without creating a separate top-level nav group.
   */
  children?: NavItem[];
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
      { title: 'Spawning an agent', slug: 'spawning-an-agent' },
      { title: 'Event handlers', slug: 'event-handlers' },
    ],
  },
  {
    title: 'Primitives',
    items: [
      {
        title: 'Message',
        slug: 'sending-messages',
        children: [
          { title: 'Channels', slug: 'channels' },
          { title: 'DMs', slug: 'dms' },
          { title: 'Threads', slug: 'threads' },
          { title: 'Emoji reactions', slug: 'emoji-reactions' },
        ],
      },
      { title: 'File', slug: 'file-sharing' },
      {
        title: 'Auth',
        slug: 'authentication',
        children: [{ title: 'Permissions', slug: 'permissions' }],
      },
      { title: 'Schedule', slug: 'scheduling' },
    ],
  },
  {
    title: 'Workflows',
    items: [
      { title: 'Introduction', slug: 'workflows-introduction' },
      { title: 'Quickstart', slug: 'workflows-quickstart' },
      { title: 'Builder API', slug: 'reference-workflows' },
      { title: 'Patterns', slug: 'workflows-patterns' },
      { title: 'Setup helpers', slug: 'workflows-setup-helpers' },
      { title: 'GitHub primitive', slug: 'github-primitive' },
      { title: 'Common mistakes', slug: 'workflows-common-mistakes' },
      { title: 'Run from CLI', slug: 'cli-workflows' },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { title: 'Cloud', slug: 'cloud' },
      { title: 'Workforce', slug: 'workforce' },
    ],
  },
  {
    title: 'Tools',
    items: [
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

/** Walk a NavItem tree and collect every slug (root + children). */
function collectSlugs(items: NavItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    out.push(item.slug);
    if (item.children) out.push(...collectSlugs(item.children));
  }
  return out;
}

/** All doc slugs including hidden pages (for static generation + search) */
const ALL_SLUGS = [
  ...docsNav.flatMap((group) => collectSlugs(group.items)),
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
  'local-mode',
  'reference-openclaw',
];

/** Flat list of all doc slugs for static generation */
export function getAllDocSlugs(): string[] {
  return [...new Set(ALL_SLUGS)];
}
