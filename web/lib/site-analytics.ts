const TRACKED_ROUTE_PREFIXES = [
  { prefix: '/docs', pageGroup: 'docs' },
  { prefix: '/blog', pageGroup: 'blog' },
  { prefix: '/primitives', pageGroup: 'primitives' },
  { prefix: '/openclaw', pageGroup: 'openclaw' },
  { prefix: '/skill', pageGroup: 'openclaw' },
] as const;

const EXCLUDED_ROUTE_PREFIXES = ['/openclaw/skill/invite/'] as const;

export type WebsiteAnalyticsPage = {
  pageGroup: (typeof TRACKED_ROUTE_PREFIXES)[number]['pageGroup'];
  pathname: string;
};

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function getWebsiteAnalyticsPage(pathname: string | null | undefined): WebsiteAnalyticsPage | null {
  if (!pathname) return null;
  if (EXCLUDED_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;

  const match = TRACKED_ROUTE_PREFIXES.find(({ prefix }) => matchesPrefix(pathname, prefix));
  if (!match) return null;

  return {
    pageGroup: match.pageGroup,
    pathname,
  };
}
