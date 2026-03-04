import { SkillPage } from '../../components/SkillPage';
import { readSkillMarkdown } from '../../lib/skill-markdown';

export const dynamic = 'force-static';
export const revalidate = 86400;

export default function OpenClawPage() {
  return <SkillPage markdown={readSkillMarkdown()} />;
}
