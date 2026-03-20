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
    title: 'Get Started',
    items: [
      { title: 'Introduction', slug: 'introduction' },
      { title: 'Quickstart', slug: 'quickstart' },
    ],
  },
  {
    title: 'Communicate',
    items: [
      { title: 'Overview', slug: 'communicate' },
      { title: 'AI SDK', slug: 'communicate/ai-sdk' },
      { title: 'Claude SDK', slug: 'communicate/claude-sdk' },
      { title: 'Google ADK', slug: 'communicate/google-adk' },
      { title: 'Pi', slug: 'communicate/pi' },
      { title: 'Agno', slug: 'communicate/agno' },
      { title: 'OpenAI Agents', slug: 'communicate/openai-agents' },
      { title: 'Swarms', slug: 'communicate/swarms' },
      { title: 'CrewAI', slug: 'communicate/crewai' },
    ],
  },
  {
    title: 'SDK Reference',
    items: [
      { title: 'TypeScript SDK', slug: 'reference/sdk' },
      { title: 'Python SDK', slug: 'reference/sdk-py' },
    ],
  },
  {
    title: 'Integrations',
    items: [{ title: 'OpenClaw', slug: 'reference/openclaw' }],
  },
];

/** Flat list of all doc slugs for static generation */
export function getAllDocSlugs(): string[] {
  return docsNav.flatMap((group) => group.items.map((item) => item.slug));
}
