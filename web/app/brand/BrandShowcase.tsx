import Link from 'next/link';
import { Download } from 'lucide-react';

import s from './brand.module.css';

type BrandKitAsset = {
  file: string;
  label: string;
  darkPreview?: boolean;
  altFile?: string;
};

const BRAND_KIT: BrandKitAsset[] = [
  { file: 'agent-relay-logo.png', label: 'Logo' },
  { file: 'agent-relay-logo-light.png', label: 'Logo · Light', darkPreview: true },
  { file: 'agent-relay-logo-tight.png', label: 'Logo · Tight' },
  { file: 'agent-relay-logo-light-tight.png', label: 'Logo · Light, Tight', darkPreview: true },
  { file: 'agent-relay-logo-horizontal.png', label: 'Logo · Horizontal' },
  { file: 'agent-relay-logo-horizontal-transparent.png', label: 'Logo · Horizontal, Transparent' },
  { file: 'agent-relay-logo-light-horizontal.png', label: 'Logo · Light, Horizontal', darkPreview: true },
  {
    file: 'agent-relay-logo-light-horizontal-transparent.png',
    label: 'Logo · Light, Horizontal, Transparent',
  },
  { file: 'agent-relay-logo-circle.png', label: 'Logo · Circle' },
  { file: 'agent-relay-logo-light-circle.png', label: 'Logo · Light, Circle', darkPreview: true },
  { file: 'agent-relay-mark.png', label: 'Mark' },
  { file: 'agent-relay-mark-transparent.png', label: 'Mark · Transparent', altFile: 'agent-relay-mark.svg' },
  { file: 'agent-relay-mark-circle.png', label: 'Mark · Circle' },
  { file: 'agent-relay-mark-light-circle.png', label: 'Mark · Light, Circle', darkPreview: true },
  { file: 'agent-relay-wordmark.svg', label: 'Wordmark · SVG', darkPreview: true },
];

export function BrandShowcase() {
  return (
    <main className={s.page}>
      <section className={s.hero}>
        <div className={s.sectionHeader}>
          <div>
            <p className={s.sectionEyebrow}>Brand Kit</p>
            <h1 className={s.sectionTitle}>Logos &amp; assets</h1>
            <p className={s.sectionText}>PNGs in various forms of the logo, mark and wordmark.</p>
          </div>
          <a href="/brand-kit/agent-relay-brand-kit.zip" download className={s.kitDownloadAll}>
            <Download aria-hidden />
            Download all (.zip)
          </a>
        </div>

        <div className={s.kitGrid}>
          {BRAND_KIT.map((asset) => (
            <article key={asset.file} className={s.kitCard}>
              <div className={`${s.kitPreview} ${asset.darkPreview ? s.kitPreviewDark : ''}`}>
                <img src={`/brand-kit/${asset.file}`} alt={asset.label} loading="lazy" />
              </div>
              <div className={s.kitMeta}>
                <div>
                  <p className={s.tokenName}>{asset.label}</p>
                  <code className={s.kitFile}>{asset.file}</code>
                </div>
                <div className={s.kitDownloadRow}>
                  <a
                    href={`/brand-kit/${asset.file}`}
                    download
                    className={s.kitDownloadBtn}
                    aria-label={`Download ${asset.label} ${asset.file.split('.').pop()?.toUpperCase()}`}
                  >
                    <Download aria-hidden />
                    {asset.file.split('.').pop()?.toUpperCase()}
                  </a>
                  {asset.altFile ? (
                    <a
                      href={`/brand-kit/${asset.altFile}`}
                      download
                      className={s.kitDownloadBtn}
                      aria-label={`Download ${asset.label} ${asset.altFile.split('.').pop()?.toUpperCase()}`}
                    >
                      <Download aria-hidden />
                      {asset.altFile.split('.').pop()?.toUpperCase()}
                    </a>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={s.themeLinkSection}>
        <Link href="/brand/theme" className={s.themeLink}>
          Explore the Agent Relay web theme →
        </Link>
      </section>
    </main>
  );
}
