import fs from 'node:fs';
import path from 'node:path';

import { ImageResponse } from 'next/og';

import { loadBrandFonts, OG_SIZE, PearVariant } from '../../../lib/og/template';

export const runtime = 'nodejs';
// Prerender at build time — the Pear card never changes between deploys.
export const dynamic = 'force-static';

/**
 * Read a public/ asset as a base64 data URL for embedding into the
 * satori-rendered card. Both assets are traced for this route via
 * `outputFileTracingIncludes` in `next.config.mjs`, so they ship with the
 * standalone/OpenNext bundle.
 *
 * We resolve against two roots because `outputFileTracingRoot` is the monorepo
 * root: at build the cwd is the `web/` package (`public/...`), while the traced
 * server runs from the monorepo root (`web/public/...`). The first hit wins.
 */
function loadAsset(publicPath: string): string | undefined {
  for (const root of ['public', 'web/public']) {
    const file = path.resolve(process.cwd(), root, publicPath);
    try {
      if (fs.existsSync(file)) {
        return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
      }
    } catch {
      // Try the next root.
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
  const screenshot = loadAsset('img/pear-app.png');
  const mark = loadAsset('brand-kit/pear-icon-transparent.png');

  return new ImageResponse(
    <PearVariant headingFamily={headingFamily} bodyFamily={bodyFamily} screenshot={screenshot} mark={mark} />,
    {
      ...OG_SIZE,
      ...(fonts.length > 0 ? { fonts } : {}),
    }
  );
}
