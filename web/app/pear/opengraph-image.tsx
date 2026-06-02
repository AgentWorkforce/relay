import fs from 'node:fs';
import path from 'node:path';

import { ImageResponse } from 'next/og';

import { loadBrandFonts, OG_CONTENT_TYPE, OG_SIZE, PearVariant } from '../../lib/og/template';

export const runtime = 'nodejs';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt =
  'Pear by Agent Relay — a desktop workspace where you pair program with a team of AI coding agents.';

/**
 * Candidate paths for the Pear desktop-app screenshot. The card is generated at
 * build time, where the working directory is the `web/` package, but we probe a
 * couple of locations so the read also works when traced into a server bundle.
 */
const SHOT_CANDIDATES = [
  path.resolve(process.cwd(), 'public/img/pear-app.png'),
  path.resolve(process.cwd(), 'web/public/img/pear-app.png'),
];

/**
 * Read the screenshot and return it as a base64 PNG data URL for embedding into
 * the satori-rendered card. Fails soft: if the file cannot be read the card
 * still renders its frame (just without the screenshot inside).
 */
function loadScreenshot(): string | undefined {
  for (const candidate of SHOT_CANDIDATES) {
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
 * desktop-app screenshot zoomed in on its top-left.
 */
export default async function PearOpenGraphImage() {
  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();
  const screenshot = loadScreenshot();

  return new ImageResponse(
    <PearVariant headingFamily={headingFamily} bodyFamily={bodyFamily} screenshot={screenshot} />,
    {
      ...OG_SIZE,
      ...(fonts.length > 0 ? { fonts } : {}),
    }
  );
}
