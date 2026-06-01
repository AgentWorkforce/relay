import Link from 'next/link';

import { MessageRelayAnimation } from '../MessageRelayAnimation';
import s from '../../app/landing.module.css';
import { GitHubIcon, HeroBackdrop } from './icons';

export function Hero() {
  return (
    <div className={s.heroSection}>
      <HeroBackdrop />
      <section className={s.hero}>
        <div className={s.heroLeft}>
          <h1 className={s.headline}>Headless Slack for Agents</h1>

          <p className={s.subtitle}>
            Channels, threads, DMs, reactions, and real-time events built for multi-agent systems. Everything
            you’d expect from Slack, exposed as an SDK.
          </p>

          <div className={s.ctas}>
            <Link href="/docs" className={s.ctaPrimary}>
              Read Docs
            </Link>
            <a
              href="https://github.com/agentworkforce/relay"
              target="_blank"
              rel="noopener noreferrer"
              className={s.ctaSecondary}
            >
              <GitHubIcon />
              GitHub
            </a>
          </div>
        </div>

        <div className={s.heroRight}>
          <MessageRelayAnimation />
        </div>
      </section>
    </div>
  );
}
