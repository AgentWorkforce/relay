import type { ReactNode } from 'react';

import { DocsNav } from '../../components/docs/DocsNav';
import { DocsSearch } from '../../components/docs/DocsSearch';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import styles from '../../components/docs/docs.module.css';
import { getSearchIndex } from '../../lib/docs';

const searchIndex = getSearchIndex();

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.docsPage}>
      <SiteNav center={<DocsSearch index={searchIndex} />} />
      <div className={styles.docsBody}>
        <div className={styles.sidebarCol}>
          <DocsNav />
        </div>
        <main className={styles.content}>{children}</main>
      </div>
      <SiteFooter />
    </div>
  );
}
