import { ImageResponse } from 'next/og';

import { DefaultVariant, loadBrandFonts, OG_CONTENT_TYPE, OG_SIZE } from '../lib/og/template';

export const runtime = 'nodejs';
export const alt =
  'Agent Relay — Headless Slack for Agents. Channels, threads, DMs, reactions, and real-time events, exposed as an SDK.';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

/**
 * Site-wide default Open Graph card: the simple variant (logo + wordmark, the
 * hero headline, and the site subtitle). This is the fallback for every page
 * that does not declare its own image. The homepage overrides it with the
 * richer `/og-home` card via its `metadata.openGraph.images`.
 */
export default async function OpenGraphImage() {
  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();

  return new ImageResponse(<DefaultVariant headingFamily={headingFamily} bodyFamily={bodyFamily} />, {
    ...OG_SIZE,
    ...(fonts.length > 0 ? { fonts } : {}),
  });
}
