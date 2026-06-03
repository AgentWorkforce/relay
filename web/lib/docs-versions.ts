import { currentDocsSlugs, legacyDocsSlugs } from './docs-nav';

export type DocsVersionId = 'v8' | 'v7.1.1';

export interface DocsVersion {
  id: DocsVersionId;
  label: string;
  shortLabel: string;
}

// v8 is the default, served at the bare `/docs` path.
// v7.1.1 is archived under `/docs/7.1.1` and reachable from the version dropdown.
export const docsVersions: DocsVersion[] = [
  { id: 'v8', label: 'v8.0.0 (latest)', shortLabel: 'v8.0.0' },
  { id: 'v7.1.1', label: 'v7.1.1', shortLabel: 'v7.1.1' },
];

export const currentDocsVersion: DocsVersionId = 'v8';
export const legacyDocsBasePath = '/docs/7.1.1';
export const v8DocsBasePath = '/docs';

function normalizePathname(pathname: string): string {
  const pathOnly = pathname.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return pathOnly || '/docs';
}

function isLegacyPath(normalized: string): boolean {
  return normalized === legacyDocsBasePath || normalized.startsWith(`${legacyDocsBasePath}/`);
}

export function getDocsVersionForPath(pathname: string): DocsVersionId {
  const normalized = normalizePathname(pathname);

  if (isLegacyPath(normalized)) {
    return 'v7.1.1';
  }

  const slug = getDocsSlugFromPath(normalized);
  if (currentDocsSlugs.includes(slug)) {
    return 'v8';
  }

  return legacyDocsSlugs.includes(slug) ? 'v7.1.1' : currentDocsVersion;
}

function getDocsSlugFromPath(pathname: string): string {
  const normalized = normalizePathname(pathname);

  if (normalized === '/docs' || normalized === legacyDocsBasePath) {
    return 'introduction';
  }

  if (normalized.startsWith(`${legacyDocsBasePath}/`)) {
    return normalized.slice(`${legacyDocsBasePath}/`.length).split('/')[0] || 'introduction';
  }

  if (normalized.startsWith('/docs/')) {
    return normalized.slice('/docs/'.length).split('/')[0] || 'introduction';
  }

  return 'introduction';
}

export function getDocsVersionHref(version: DocsVersionId, pathname: string): string {
  const slug = getDocsSlugFromPath(pathname);

  if (version === 'v7.1.1') {
    return legacyDocsSlugs.includes(slug)
      ? `${legacyDocsBasePath}/${slug}`
      : `${legacyDocsBasePath}/introduction`;
  }

  return currentDocsSlugs.includes(slug) ? `${v8DocsBasePath}/${slug}` : `${v8DocsBasePath}/introduction`;
}

export function getDefaultDocsVersionForSlug(slug: string): DocsVersionId {
  if (currentDocsSlugs.includes(slug)) {
    return 'v8';
  }

  return legacyDocsSlugs.includes(slug) ? 'v7.1.1' : currentDocsVersion;
}
