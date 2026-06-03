import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { getDoc } from '../../../../lib/docs';
import { getAllDocSlugs } from '../../../../lib/docs-nav';
import { DefaultVariant, loadBrandFonts, OG_SIZE } from '../../../../lib/og/template';

export const runtime = 'nodejs';
// Prerender one card per doc at build time. The doc set is fixed per deploy.
export const dynamic = 'force-static';

type RouteContext = {
  params: Promise<{ slug: string }>;
};

/** Prerender a card for every current (v8) doc. */
export function generateStaticParams() {
  return getAllDocSlugs().map((slug) => ({ slug }));
}

/**
 * Per-doc Open Graph card: the default variant with a "Documentation" eyebrow
 * plus the doc title and description. Served as a `.png` route handler so the
 * URL ends in a real image extension. `app/docs/[slug]/page.tsx` points its
 * `openGraph.images` here.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { slug } = await params;
  const doc = getDoc(slug);

  if (!doc) {
    notFound();
  }

  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();

  return new ImageResponse(
    <DefaultVariant
      headingFamily={headingFamily}
      bodyFamily={bodyFamily}
      eyebrow="Documentation"
      title={doc.frontmatter.title}
      subtitle={doc.frontmatter.description}
    />,
    {
      ...OG_SIZE,
      ...(fonts.length > 0 ? { fonts } : {}),
    }
  );
}
