import Link from 'next/link';

import { useCasePages } from '../lib/use-cases';
import styles from './openclaw-use-case-footer.module.css';

export function OpenClawUseCaseFooter() {
  return (
    <section className={styles.section} aria-labelledby="openclaw-use-cases-title">
      <div className={styles.header}>
        <p className={styles.eyebrow}>OpenClaw SEO landing pages</p>
        <h2 id="openclaw-use-cases-title" className={styles.title}>Explore Agent Relay use cases</h2>
        <p className={styles.copy}>
          These landing pages focus on the ways teams actually use Agent Relay with OpenClaw: multi-agent coding,
          direct agent messaging, human approvals, and Slack-style coordination patterns.
        </p>
      </div>

      <ul className={styles.grid}>
        {useCasePages.map((page) => (
          <li key={page.slug}>
            <Link href={`/openclaw/use-cases/${page.slug}`} className={styles.card}>
              <span className={styles.cardTitle}>{page.title}</span>
              <span className={styles.cardDescription}>{page.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
