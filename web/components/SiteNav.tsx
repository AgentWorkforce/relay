import Link from 'next/link';

import { GitHubStars } from './GitHubStars';
import s from './site-nav.module.css';

function GithubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function LogoIcon() {
  return (
    <svg
      className={s.logoIcon}
      viewBox="0 0 112 91"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M71.3682 21.7098L54.042 39.036C50.6567 42.4213 50.6568 47.9099 54.042 51.2952L71.3727 68.6259L52.8321 87.1665C48.6005 91.3981 41.7397 91.3981 37.5081 87.1665L3.17369 52.8321C-1.05789 48.6005 -1.0579 41.7397 3.17369 37.5081L37.5081 3.17369C41.7397 -1.0579 48.6005 -1.05789 52.8321 3.17369L71.3682 21.7098Z"
        fill="#2D4F3E"
      />
      <path
        d="M75.5711 72.8243C78.9563 76.2096 84.445 76.2096 87.8302 72.8243L109.359 51.2952C112.745 47.9099 112.745 42.4213 109.359 39.036L87.8302 17.507C84.445 14.1218 78.9563 14.1218 75.5711 17.507L71.3682 21.7098L88.6989 39.0405C92.0842 42.4258 92.0842 47.9144 88.6989 51.2997L71.3727 68.6259L75.5711 72.8243Z"
        fill="#6C7A71"
      />
    </svg>
  );
}

export function SiteNav() {
  return (
    <nav className={s.nav}>
      <Link href="/" className={s.logo}>
        <LogoIcon />
        Agent Relay
      </Link>

      <ul className={s.links}>
        <li>
          <Link href="/" className={s.link}>
            Platform
          </Link>
        </li>
        <li>
          <Link href="/docs" className={s.link}>
            Docs
          </Link>
        </li>
        <li>
          <Link href="/pricing" className={s.link}>
            Pricing
          </Link>
        </li>
        <li>
          <a
            href="https://github.com/agentworkforce/relay"
            target="_blank"
            rel="noopener noreferrer"
            className={`${s.link} ${s.linkGh}`}
          >
            <GithubIcon />
            Star on GitHub
            <GitHubStars />
          </a>
        </li>
      </ul>

      <Link href="/docs/quickstart" className={s.cta}>
        Get Started
      </Link>
    </nav>
  );
}
