import readme from '../../../README.md?raw';

export const dynamic = 'force-static';

export function GET() {
  return new Response(readme, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
