import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { getDoc } from '../../../lib/docs';
import { DefaultVariant, loadBrandFonts, OG_CONTENT_TYPE, OG_SIZE } from '../../../lib/og/template';

export const runtime = 'nodejs';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Agent Relay documentation';

type PageProps = {
  params: Promise<{ slug: string }>;
};

export default async function DocsOpenGraphImage({ params }: PageProps) {
  const { slug } = await params;
  const doc = getDoc(slug);

  if (!doc) {
    notFound();
  }

  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();

  return new ImageResponse(
    (
      <DefaultVariant
        headingFamily={headingFamily}
        bodyFamily={bodyFamily}
        eyebrow="Documentation"
        title={doc.frontmatter.title}
        subtitle={doc.frontmatter.description}
      />
    ),
    {
      ...OG_SIZE,
      ...(fonts.length > 0 ? { fonts } : {}),
    }
  );
}
