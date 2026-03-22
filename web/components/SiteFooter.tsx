import Link from 'next/link';

import { useCasePages } from '../lib/use-cases';
import { LogoIcon, LogoWordmark } from './SiteNav';
import s from './site-footer.module.css';

export function SiteFooter() {
  return (
    <footer className={s.footer}>
      <div className={s.inner}>
        <div className={s.brand}>
          <Link href="/" className={s.logo}>
            <LogoIcon />
            <LogoWordmark />
          </Link>
          <p className={s.tagline}>The future is multi-agent. Build it with Relay.</p>
        </div>

        <div className={s.columns}>
          <div className={s.col}>
            <h4 className={s.colTitle}>Product</h4>
            <Link href="/docs" className={s.link}>Documentation</Link>
            <Link href="/docs/quickstart" className={s.link}>Quickstart</Link>
            <Link href="/docs/reference-sdk" className={s.link}>SDK Reference</Link>
            <a href="https://agent-relay.com" className={s.link}>Cloud</a>
          </div>
          <div className={s.col}>
            <h4 className={s.colTitle}>OpenClaw use cases</h4>
            {useCasePages.slice(0, 4).map((page) => (
              <Link key={page.slug} href={`/openclaw/use-cases/${page.slug}`} className={s.link}>
                {page.navLabel}
              </Link>
            ))}
          </div>
          <div className={s.col}>
            <h4 className={s.colTitle}>Community</h4>
            <a href="https://github.com/agentworkforce/relay" target="_blank" rel="noopener noreferrer" className={s.link}>GitHub</a>
            <Link href="/blog" className={s.link}>Blog</Link>
            <a href="https://twitter.com/agent_relay" target="_blank" rel="noopener noreferrer" className={s.link}>Twitter</a>
          </div>
          <div className={s.col}>
            <h4 className={s.colTitle}>Company</h4>
            <Link href="/openclaw" className={s.link}>OpenClaw</Link>
            <Link href="/openclaw/skill" className={s.link}>Hosted skill</Link>
            <a href="mailto:hello@agentrelay.dev" className={s.link}>Contact</a>
          </div>
        </div>
      </div>

      <div className={s.bottom}>
        <p className={s.copy}>&copy; {new Date().getFullYear()} Agent Relay. All rights reserved.</p>
        <div className={s.socials}>
          <a href="https://github.com/agentworkforce/relay" target="_blank" rel="noopener noreferrer" aria-label="GitHub" className={s.social}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
          </a>
          <a href="https://twitter.com/agent_relay" target="_blank" rel="noopener noreferrer" aria-label="Twitter" className={s.social}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
          </a>
        </div>
      </div>
    </footer>
  );
}
