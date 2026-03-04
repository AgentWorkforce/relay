export function SkillPage({ markdown }: { markdown: string }) {
  return (
    <main>
      <h1>Agent Relay for OpenClaw</h1>
      <pre>{markdown}</pre>
    </main>
  );
}
