import { absoluteUrl } from './site';

/**
 * Open Graph image metadata helpers.
 *
 * The OG cards are PNGs referenced by `metadata.openGraph.images` /
 * `metadata.twitter.images`, so every page references a real `.png` URL and
 * declares `og:image:type`.
 *
 * Site-wide cards are checked in under `public/og/` so crawlers see plain static
 * assets. Per-page blog/docs cards still use generated `og.png` route handlers.
 *
 * Kept free of any React/satori imports so importing it into page metadata does
 * not pull the image-template module into page bundles.
 */

/** Standard OG card dimensions (1200×630), matching `OG_SIZE` in `lib/og/template`. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/**
 * A fully-specified Open Graph image descriptor. Assignable to both
 * `metadata.openGraph.images` and (via `.url`) `metadata.twitter.images`.
 */
export interface OgImage {
  url: string;
  width: number;
  height: number;
  type: 'image/png';
  alt: string;
}

/**
 * Build an `openGraph.images` entry for one of our PNG card routes.
 * @param path - Absolute-from-root path to the card (e.g. `/og-home.png`).
 * @param alt - Accessible description of the card.
 */
export function ogImage(path: string, alt: string): OgImage {
  return {
    url: absoluteUrl(path),
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    type: 'image/png',
    alt,
  };
}

/** Alt text for the site-wide default card. */
export const DEFAULT_OG_ALT = 'Agent Relay — Headless Slack for Agents';

/** Static public card paths. Change the version suffix when the visual changes to bust social caches. */
export const HOME_OG_IMAGE_PATH = '/og/agent-relay-home-v20260610.png';
export const DEFAULT_OG_IMAGE_PATH = '/og/agent-relay-default-v20260610.png';

/** The site-wide default card. */
export function defaultOgImage(): OgImage {
  return ogImage(DEFAULT_OG_IMAGE_PATH, DEFAULT_OG_ALT);
}
