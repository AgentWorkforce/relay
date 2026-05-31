import { ImageResponse } from 'next/og';

import { LandingVariant, loadBrandFonts, OG_SIZE } from '../../lib/og/template';

export const runtime = 'nodejs';

/**
 * The homepage's rich Open Graph card: the landing variant (logo + wordmark,
 * hero headline, tagline, and the live-style chat panel). Served as a route
 * handler so the prerendered root `opengraph-image` can stay the simple
 * site-wide fallback. `app/page.tsx` points its `openGraph.images` here.
 */
export async function GET() {
  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();

  return new ImageResponse(<LandingVariant headingFamily={headingFamily} bodyFamily={bodyFamily} />, {
    ...OG_SIZE,
    // Render 👍 (and any emoji) as Twemoji graphics rather than relying on a
    // system emoji font satori may not have.
    emoji: 'twemoji',
    ...(fonts.length > 0 ? { fonts } : {}),
  });
}
