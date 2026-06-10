type SkillPageProps = {
  eyebrow?: string;
  title: string;
  lead: string;
  markdown: string;
};

export function SkillPage({ eyebrow = 'Hosted Skill', title, lead, markdown }: SkillPageProps) {
  return (
    <main className="skill-page">
      <header className="skill-page__header">
        <p className="skill-page__eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="skill-page__lead">{lead}</p>
      </header>
      <pre>{markdown}</pre>
    </main>
  );
}
