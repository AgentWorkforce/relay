'use client';

import { usePathname } from 'next/navigation';

import { docsNav } from '../../lib/docs-nav';
import styles from './docs.module.css';

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav className={styles.sidebar} aria-label="Documentation">
      <a href="/docs" className={styles.sidebarLogo}>
        <img src="/agent-relay-logo-white.svg" alt="Agent Relay" width={120} height={20} />
      </a>
      {docsNav.map((group) => (
        <div key={group.title} className={styles.navGroup}>
          <h4 className={styles.navGroupTitle}>{group.title}</h4>
          <ul className={styles.navList}>
            {group.items.map((item) => {
              const href = `/docs/${item.slug}`;
              const isActive = pathname === href || (item.slug === 'introduction' && pathname === '/docs');
              return (
                <li key={item.slug}>
                  <a
                    href={href}
                    className={`${styles.navLink} ${isActive ? styles.navLinkActive : ''}`}
                  >
                    {item.title}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
