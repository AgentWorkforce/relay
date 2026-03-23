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
    title: 'SDK',
    items: [
      { title: 'TypeScript SDK Reference', slug: 'reference-sdk' },
      { title: 'Python SDK Reference', slug: 'reference-sdk-py' },
    ],
  },
  {
    title: 'Integrations',
    items: [{ title: 'OpenClaw Bridge', slug: 'reference-openclaw' }],
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
];

/** Flat list of all doc slugs for static generation */
export function getAllDocSlugs(): string[] {
  return ALL_SLUGS;
}
