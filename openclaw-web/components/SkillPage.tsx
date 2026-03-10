export function SkillPage({ markdown }: { markdown: string }) {
  return (
    <main className="skill-page">
      <header className="skill-page__header">
        <p className="skill-page__eyebrow">Hosted Skill</p>
        <h1>Agent Relay for OpenClaw</h1>
        <p className="skill-page__lead">
          Full setup, verification, messaging, and troubleshooting instructions for connecting an OpenClaw
          instance to Agent Relay.
        </p>
      </header>
      <pre>{markdown}</pre>
    </main>
  );
}
