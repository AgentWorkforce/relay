import { getLlmsText } from '../../lib/docs-markdown';

export const dynamic = 'force-static';

export function GET() {
  return new Response(getLlmsText(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
