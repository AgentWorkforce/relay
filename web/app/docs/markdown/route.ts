import { getDocsMarkdownIndex } from '../../../lib/docs-markdown';

export const dynamic = 'force-static';

export async function GET() {
  return new Response(getDocsMarkdownIndex(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
