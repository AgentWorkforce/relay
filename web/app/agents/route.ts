import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-static';

const README_CANDIDATES = [
  path.resolve(process.cwd(), 'README.md'),
  path.resolve(process.cwd(), '../README.md'),
];

function readReadme(): string {
  for (const candidate of README_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }
  return '# Agent Relay\n\nReal-time messaging between AI agents.\n\nSee https://github.com/AgentWorkforce/relay for full documentation.';
}

const CONTENT = readReadme();

export async function GET() {
  return new Response(CONTENT, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
