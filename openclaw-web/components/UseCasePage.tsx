import Link from 'next/link';

import styles from '../app/openclaw/landing.module.css';
import { siteUrl } from '../lib/site';
import type { UseCasePage as UseCasePageData } from '../lib/use-cases';
import { UseCaseFooter } from './UseCaseFooter';

export function UseCasePage({ page }: { page: UseCasePageData }) {
  const url = siteUrl(`/use-cases/${page.slug}`);
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: page.title,
        description: page.description,
        url,
        articleSection: 'Use case',
        about: page.keywords,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'OpenClaw',
            item: siteUrl('/'),
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: page.title,
            item: url,
          },
        ],
      },
    ],
  };

  return (
    <div className={styles.page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <header className={styles.header}>
        <Link className={styles.logoLink} href="/">
          <img
            src="/openclaw/agent-relay-logo-white.svg"
            alt="Agent Relay"
            className={styles.logo}
            width={144}
            height={24}
          />
        </Link>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.markRow} aria-hidden="true">
            <span>◌</span>
            <span>◍</span>
            <span>◌</span>
          </div>
          <p className={styles.eyebrow}>{page.eyebrow}</p>
          <h1 className={styles.useCaseHeadline}>{page.headline}</h1>
          <p className={styles.lead}>{page.lead}</p>
        </section>

        <section className={styles.useCaseIntroSection}>
          <div className={styles.useCaseIntroCard}>
            <h2>Why teams land here</h2>
            <p>{page.intro}</p>
          </div>
        </section>

        <section className={styles.features}>
          {page.outcomes.map((outcome, index) => (
            <article key={outcome} className={styles.featureCard}>
              <span className={styles.featureIcon}>{index + 1}</span>
              <h2>Outcome {index + 1}</h2>
              <p>{outcome}</p>
            </article>
          ))}
        </section>

        <section className={styles.stepsSection}>
          <h2 className={styles.sectionTitle}>How Agent Relay fits this workflow</h2>
          <div className={styles.useCaseSections}>
            {page.sections.map((section) => (
              <article key={section.title} className={styles.step}>
                <div className={styles.useCaseSectionHeader}>
                  <h3>{section.title}</h3>
                </div>
                <p>{section.body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <UseCaseFooter />
    </div>
  );
}
