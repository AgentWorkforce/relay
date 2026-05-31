import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';

import { getPost } from '../../../lib/blog';
import { BlogVariant, loadBrandFonts, OG_CONTENT_TYPE, OG_SIZE } from '../../../lib/og/template';

export const runtime = 'nodejs';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Agent Relay blog post';

type PageProps = {
  params: Promise<{ slug: string }>;
};

function formatDate(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default async function BlogPostOpenGraphImage({ params }: PageProps) {
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
