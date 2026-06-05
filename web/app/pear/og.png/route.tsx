import fs from 'node:fs';
import path from 'node:path';

import { ImageResponse } from 'next/og';

import { loadBrandFonts, OG_SIZE, PearVariant } from '../../../lib/og/template';

export const runtime = 'nodejs';
// Prerender at build time — the Pear card never changes between deploys.
export const dynamic = 'force-static';

/**
 * Candidate paths for the Pear desktop-app screenshot. The card is generated at
 * build time, where the working directory is the `web/` package, but we probe a
 * couple of locations so the read also works when traced into a server bundle.
 */
const SHOT_CANDIDATES = [
  path.resolve(process.cwd(), 'public/img/pear-app.png'),
  path.resolve(process.cwd(), 'web/public/img/pear-app.png'),
];

/** Candidate paths for the brand-kit pear mark (transparent). */
const MARK_CANDIDATES = [
  path.resolve(process.cwd(), 'public/brand-kit/pear-icon-transparent.png'),
  path.resolve(process.cwd(), 'web/public/brand-kit/pear-icon-transparent.png'),
];

/**
 * Read a PNG and return it as a base64 data URL for embedding into the
 * satori-rendered card. Fails soft: if no candidate can be read the caller
 * renders its fallback (the card never breaks).
 */
function loadPng(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const data = fs.readFileSync(candidate);
        return `data:image/png;base64,${data.toString('base64')}`;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * The Pear landing page's Open Graph card: the same composition as the homepage
 * card (left copy column, a graphic bled into the bottom-right with the
 * terracotta accent peeking at its top-left), but the graphic is the real Pear
 * desktop-app screenshot zoomed in on its top-left. Served as a `.png` route
 * handler so the URL ends in a real image extension.
 */
export async function GET() {
  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();
  const screenshot = loadPng(SHOT_CANDIDATES);
  const mark = loadPng(MARK_CANDIDATES);

  return new ImageResponse(
    <PearVariant headingFamily={headingFamily} bodyFamily={bodyFamily} screenshot={screenshot} mark={mark} />,
    {
      ...OG_SIZE,
      ...(fonts.length > 0 ? { fonts } : {}),
    }
  );
}
