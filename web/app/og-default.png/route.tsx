import { ImageResponse } from 'next/og';

import { DefaultVariant, loadBrandFonts, OG_SIZE } from '../../lib/og/template';

export const runtime = 'nodejs';
// Prerender at build time — the site-wide default card is identical between
// deploys, so render it once and serve the static PNG.
export const dynamic = 'force-static';

/**
 * Site-wide default Open Graph card: the simple variant (logo + wordmark, the
 * hero headline, and the site subtitle). Pages that do not generate their own
 * card point their `openGraph.images` here (directly, or by inheriting the
 * default set in the root layout). Served as a `.png` route handler so the URL
 * ends in a real image extension.
 */
export async function GET() {
  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();

  return new ImageResponse(<DefaultVariant headingFamily={headingFamily} bodyFamily={bodyFamily} />, {
    ...OG_SIZE,
    ...(fonts.length > 0 ? { fonts } : {}),
  });
}
