import { currentDocsSlugs, legacyDocsSlugs } from './docs-nav';

export type DocsVersionId = 'v8' | 'v7.1.1';

export interface DocsVersion {
  id: DocsVersionId;
  label: string;
  shortLabel: string;
}

export const docsVersions: DocsVersion[] = [
  { id: 'v7.1.1', label: 'v7.1.1 (latest)', shortLabel: 'v7.1.1' },
  { id: 'v8', label: 'v8.0.0 (preview)', shortLabel: 'v8.0.0' },
];

export const currentDocsVersion: DocsVersionId = 'v7.1.1';
export const legacyDocsBasePath = '/docs/7.1.1';
export const v8DocsBasePath = '/docs/8.0.0';

function normalizePathname(pathname: string): string {
  const pathOnly = pathname.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return pathOnly || '/docs';
}

export function getDocsVersionForPath(pathname: string): DocsVersionId {
  const normalized = normalizePathname(pathname);

  if (normalized.startsWith(v8DocsBasePath)) {
    return 'v8';
  }

  if (normalized.startsWith(legacyDocsBasePath)) {
    return 'v7.1.1';
  }

  const slug = getDocsSlugFromPath(normalized);
  if (legacyDocsSlugs.includes(slug)) {
    return 'v7.1.1';
  }

  return currentDocsSlugs.includes(slug) ? 'v8' : currentDocsVersion;
}

function getDocsSlugFromPath(pathname: string): string {
  const normalized = normalizePathname(pathname);

  if (normalized === '/docs' || normalized === legacyDocsBasePath || normalized === v8DocsBasePath) {
    return 'introduction';
  }

  if (normalized.startsWith(`${v8DocsBasePath}/`)) {
    return normalized.slice(`${v8DocsBasePath}/`.length).split('/')[0] || 'introduction';
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
    return legacyDocsSlugs.includes(slug) ? `/docs/${slug}` : '/docs/introduction';
  }

  return currentDocsSlugs.includes(slug) ? `${v8DocsBasePath}/${slug}` : `${v8DocsBasePath}/introduction`;
}

export function getDefaultDocsVersionForSlug(slug: string): DocsVersionId {
  if (legacyDocsSlugs.includes(slug)) {
    return 'v7.1.1';
  }

  return currentDocsSlugs.includes(slug) ? 'v8' : currentDocsVersion;
}
