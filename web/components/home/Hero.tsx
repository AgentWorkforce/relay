import Link from 'next/link';

import { HeroGraph } from './HeroGraph';
import s from '../../app/landing.module.css';
import { GitHubIcon, HeroBackdrop } from './icons';

export function Hero() {
  return (
    <div className={s.heroSection}>
      <HeroBackdrop />
      <section className={s.hero}>
        <div className={s.heroLeft}>
          <h1 className={s.headline}>Let your agents talk</h1>

          <p className={s.subtitle}>
            Give Claude, Codex or any other agent DMs, channels and a searchable chat history. Build your
            multi-agent system without worrying about the glue.
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
          <HeroGraph />
        </div>
      </section>
    </div>
  );
}
