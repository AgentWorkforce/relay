import type { ReactNode } from 'react';

import { DocsNav } from '../../components/docs/DocsNav';
import { SiteNav } from '../../components/SiteNav';
import styles from '../../components/docs/docs.module.css';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.docsPage}>
      <SiteNav />
      <div className={styles.docsBody}>
        <DocsNav />
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
