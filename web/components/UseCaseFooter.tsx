import Link from 'next/link';

import { useCasePages } from '../lib/use-cases';
import styles from './use-case-footer.module.css';

export function UseCaseFooter() {
  return (
    <section className={styles.section} aria-labelledby="use-cases-title">
      <div className={styles.header}>
        <p className={styles.eyebrow}>Agent Relay use cases</p>
        <h2 id="use-cases-title" className={styles.title}>Explore more Agent Relay use cases</h2>
        <p className={styles.copy}>
          These landing pages focus on the ways teams actually use Agent Relay: multi-agent coding,
          direct agent messaging, human approvals, and Slack-style coordination patterns.
        </p>
      </div>

      <ul className={styles.grid}>
        {useCasePages.map((page) => (
          <li key={page.slug}>
            <Link href={`/use-cases/${page.slug}`} className={styles.card}>
              <span className={styles.cardTitle}>{page.title}</span>
              <span className={styles.cardDescription}>{page.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
