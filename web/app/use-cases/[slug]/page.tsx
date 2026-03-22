import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { SiteFooter } from '../../../components/SiteFooter';
import { SiteNav } from '../../../components/SiteNav';
import { UseCaseFooter } from '../../../components/UseCaseFooter';
import { siteUrl } from '../../../lib/site';
import { useCasePageMap, useCasePages } from '../../../lib/use-cases';
import styles from './use-case.module.css';

type PageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export function generateStaticParams() {
  return useCasePages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = useCasePageMap.get(slug);

  if (!page) {
    return {
      title: 'Agent Relay use case',
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const url = siteUrl(`/use-cases/${page.slug}`);

  return {
    title: page.title,
    description: page.description,
    keywords: page.keywords,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: page.title,
      description: page.description,
      url,
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      title: page.title,
      description: page.description,
    },
  };
}

export default async function UseCasePage({ params }: PageProps) {
  const { slug } = await params;
  const page = useCasePageMap.get(slug);

  if (!page) notFound();

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: page.title,
    description: page.description,
    url: siteUrl(`/use-cases/${page.slug}`),
    isPartOf: {
      '@type': 'WebSite',
      name: 'Agent Relay',
      url: siteUrl('/'),
    },
    about: ['Agent Relay', 'multi-agent workflows', 'AI agent orchestration'],
  };

  return (
    <div className={styles.page}>
      <SiteNav />

      <main className={styles.main}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />

        <section className={styles.hero}>
          <p className={styles.eyebrow}>{page.eyebrow}</p>
          <h1 className={styles.title}>{page.headline}</h1>
          <p className={styles.lead}>{page.lead}</p>

          <div className={styles.ctaRow}>
            <Link href="/docs/quickstart" className={styles.primaryCta}>
              Read the quickstart
            </Link>
            <Link href="/" className={styles.secondaryCta}>
              Back to Agent Relay
            </Link>
          </div>
        </section>

        <section className={styles.introCard}>
          <h2 className={styles.cardTitle}>Why teams search for this</h2>
          <p className={styles.cardBody}>{page.intro}</p>
        </section>

        <section className={styles.outcomesCard}>
          <h2 className={styles.cardTitle}>What you get with Agent Relay</h2>
          <ul className={styles.outcomes}>
            {page.outcomes.map((outcome) => (
              <li key={outcome}>{outcome}</li>
            ))}
          </ul>
        </section>

        <section className={styles.sections}>
          {page.sections.map((section) => (
            <article key={section.title} className={styles.sectionCard}>
              <h2 className={styles.cardTitle}>{section.title}</h2>
              <p className={styles.cardBody}>{section.body}</p>
            </article>
          ))}
        </section>

        <UseCaseFooter />
      </main>

      <SiteFooter />
    </div>
  );
}
