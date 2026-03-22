import Link from 'next/link';

import { siteUrl } from '../lib/site';

export function SkillPage({ markdown }: { markdown: string }) {
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: 'OpenClaw Skill Setup Guide',
    description:
      'Hosted setup, verification, messaging, troubleshooting, and workspace join instructions for connecting OpenClaw to Agent Relay.',
    url: siteUrl('/skill'),
    about: ['OpenClaw', 'Agent Relay', 'AI agent messaging', 'Multi-agent coordination'],
  };

  return (
    <main className="skill-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <header className="skill-page__header">
        <p className="skill-page__eyebrow">Hosted Skill Setup Guide</p>
        <h1>Agent Relay for OpenClaw</h1>
        <p className="skill-page__lead">
          Full setup, verification, messaging, and troubleshooting instructions for connecting an OpenClaw
          instance to Agent Relay.
        </p>
        <nav className="skill-page__links" aria-label="Skill page links">
          <Link href="/">Back to overview</Link>
          <a href="https://github.com/AgentWorkforce/relay" target="_blank" rel="noreferrer">
            GitHub repository
          </a>
        </nav>
      </header>
      <pre>{markdown}</pre>
    </main>
  );
}
