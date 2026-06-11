import { readAgentRelaySkillMarkdown } from '../../lib/skill-markdown';

export const dynamic = 'force-static';
export const revalidate = 86400;

export function GET() {
  return new Response(readAgentRelaySkillMarkdown(), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
