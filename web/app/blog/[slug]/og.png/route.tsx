import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { getAllPosts, getPost } from '../../../../lib/blog';
import { BlogVariant, loadBrandFonts, OG_SIZE } from '../../../../lib/og/template';

export const runtime = 'nodejs';
// Prerender one card per post at build time. The post set is fixed per deploy,
// so there is no need to render (or re-fetch the brand fonts) per request.
export const dynamic = 'force-static';

type RouteContext = {
  params: Promise<{ slug: string }>;
};

/** Prerender a card for every published post. */
export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

function formatDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Per-post Open Graph card: the blog variant (title, author, date, reading
 * time). Served as a `.png` route handler so the URL ends in a real image
 * extension. `app/blog/[slug]/page.tsx` points its `openGraph.images` here
 * (unless the post declares its own `coverImage`).
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { slug } = await params;
  const post = getPost(slug);

  if (!post) {
    notFound();
  }

  const { fonts, headingFamily, bodyFamily } = await loadBrandFonts();
  const { frontmatter } = post;

  return new ImageResponse(
    <BlogVariant
      headingFamily={headingFamily}
      bodyFamily={bodyFamily}
      title={frontmatter.title}
      author={frontmatter.author}
      date={formatDate(frontmatter.date)}
      meta={post.readTime}
      category={frontmatter.category}
    />,
    {
      ...OG_SIZE,
      ...(fonts.length > 0 ? { fonts } : {}),
    }
  );
}
