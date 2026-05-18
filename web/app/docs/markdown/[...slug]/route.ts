import { getDocMarkdown } from '../../../../lib/docs-markdown';

export const dynamic = 'force-static';

type RouteProps = {
  params: Promise<{ slug: string[] }>;
};

export async function GET(_request: Request, { params }: RouteProps) {
  const { slug: segments } = await params;
  const rawSlug = segments.at(-1) ?? '';
  const slug = rawSlug.replace(/\.md$/, '');

  if (segments.length !== 1 || !slug) {
    return new Response('Not found', { status: 404 });
  }

  const doc = getDocMarkdown(slug);

  if (!doc) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(doc.markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
