export const SITE_URL = 'https://agentrelay.dev';
export const SITE_NAME = 'Agent Relay';
export const PRODUCT_NAME = 'Agent Relay for OpenClaw';
export const DEFAULT_OG_IMAGE = '/opengraph-image';

export const DEFAULT_DESCRIPTION =
  'Connect OpenClaw to Agent Relay with real-time channels, DMs, threads, reactions, observer mode, and a hosted skill page for faster multi-agent setup.';

export function sitePath(path = '/') {
  if (!path || path === '/') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export function siteUrl(path = '/') {
  return `${SITE_URL}${sitePath(path)}`;
}
