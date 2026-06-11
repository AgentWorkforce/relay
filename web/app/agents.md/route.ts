import fs from 'node:fs';
import path from 'node:path';

// Markdown endpoint for /agents, relocated from app/agents/route.ts so that
// app/agents/page.tsx can serve the HTML gallery. Preserves the original
// Content-Type and Cache-Control so any external LLM tooling that fetched the
// markdown keeps working at /agents.md.

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
