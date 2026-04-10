import Link from 'next/link';

import { SITE_EMAIL } from '../lib/site';
import { LogoIcon, LogoWordmark } from './SiteNav';
import { ThemeToggle } from './ThemeToggle';
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
            <h4 className={s.colTitle}>Resources</h4>
            <Link href="/docs/introduction" className={s.link}>
              Getting Started
            </Link>
            <Link href="/docs/spawning-an-agent" className={s.link}>
              Basics
            </Link>
            <Link href="/docs/reference-workflows" className={s.link}>
              Advanced
            </Link>
            <Link href="/docs/cli-overview" className={s.link}>
              CLI
            </Link>
            <Link href="/docs/typescript-sdk" className={s.link}>
              SDKs
            </Link>
            <Link href="/docs/plugin-claude-code" className={s.link}>
              Plugins
            </Link>
            <Link href="/docs/typescript-examples" className={s.link}>
              Examples
            </Link>
          </div>
          <div className={s.col}>
            <h4 className={s.colTitle}>Company</h4>
            <Link href="/cloud" className={s.link}>
              Cloud
            </Link>
            <Link href="/blog" className={s.link}>
              Blog
            </Link>
            <a href={`mailto:${SITE_EMAIL}`} className={s.link}>
              Contact
            </a>
          </div>
        </div>
      </div>

      <div className={s.bottom}>
        <div className={s.bottomMeta}>
          <div className={s.footerToggle}>
            <ThemeToggle />
          </div>
          <p className={s.copy}>&copy; {new Date().getFullYear()} Agent Relay. All rights reserved.</p>
        </div>
        <div className={s.socials}>
          <a
            href="https://github.com/agentworkforce/relay"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
            className={s.social}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
          <a
            href="https://twitter.com/agent_relay"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X"
            className={s.social}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <a
            href="https://discord.gg/RJGE7CHV"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Discord"
            className={s.social}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.369a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.078.037c-.211.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.249.077.077 0 0 0-.078-.037 19.736 19.791 0 0 0-4.885 1.515.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 13.83 13.83 0 0 0 1.226-1.994.076.076 0 0 0-.041-.104 13.108 13.108 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.095.252-.194.372-.295a.074.074 0 0 1 .078-.011c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.102.246.201.373.296a.077.077 0 0 1-.006.128 12.299 12.299 0 0 1-1.873.891.076.076 0 0 0-.04.105c.36.698.773 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .031-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.175 1.094 2.157 2.418 0 1.334-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.418 2.157-2.418 1.21 0 2.175 1.094 2.157 2.418 0 1.334-.947 2.419-2.157 2.419Z" />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
}
