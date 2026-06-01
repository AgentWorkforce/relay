'use client';

import { useId } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';

import { docsVersions, getDocsVersionForPath, getDocsVersionHref } from '../../lib/docs-versions';
import styles from './docs.module.css';

export function DocsVersionSelect() {
  const id = useId();
  const pathname = usePathname() ?? '/docs';
  const router = useRouter();
  const activeVersion = getDocsVersionForPath(pathname);

  return (
    <div className={styles.versionControl}>
      <label className={styles.versionLabel} htmlFor={id}>
        Version
      </label>
      <div className={styles.versionSelectWrap}>
        <select
          id={id}
          className={styles.versionSelect}
          value={activeVersion}
          aria-label="Documentation version"
          onChange={(event) => {
            router.push(getDocsVersionHref(event.target.value as typeof activeVersion, pathname));
          }}
        >
          {docsVersions.map((version) => (
            <option key={version.id} value={version.id}>
              {version.label}
            </option>
          ))}
        </select>
        <ChevronDown className={styles.versionChevron} aria-hidden="true" />
      </div>
    </div>
  );
}
