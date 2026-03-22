export const SITE_URL = 'https://agentrelay.dev';
export const SITE_NAME = 'Agent Relay';

export function sitePath(path = '/') {
  if (!path || path === '/') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export function siteUrl(path = '/') {
  return `${SITE_URL}${sitePath(path)}`;
}
