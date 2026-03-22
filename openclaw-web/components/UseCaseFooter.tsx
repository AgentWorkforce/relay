import Link from 'next/link';

import styles from '../app/openclaw/landing.module.css';
import { useCasePages } from '../lib/use-cases';

export function UseCaseFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.main}>
        <div className={styles.footerInner}>
          <div>
            <p className={styles.footerEyebrow}>Use cases</p>
            <h2 className={styles.footerTitle}>Explore Agent Relay landing pages</h2>
            <p className={styles.footerCopy}>
              These pages cover common ways teams use Agent Relay to coordinate OpenClaw-connected agents.
            </p>
          </div>
          <nav aria-label="Agent Relay use cases">
            <ul className={styles.footerLinks}>
              {useCasePages.map((page) => (
                <li key={page.slug}>
                  <Link href={`/use-cases/${page.slug}`}>{page.navLabel}</Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
