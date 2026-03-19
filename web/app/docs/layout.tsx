import type { ReactNode } from 'react';

import { DocsNav } from '../../components/docs/DocsNav';
import styles from '../../components/docs/docs.module.css';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.docsLayout}>
      <DocsNav />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
