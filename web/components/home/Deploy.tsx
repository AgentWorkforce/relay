import { FadeIn } from '../FadeIn';
import s from '../../app/landing.module.css';
import { CloudIcon, MonitorIcon } from './icons';

interface DeployOption {
  href: string;
  label: string;
  icon: React.ReactNode;
  title: string;
  text: string;
}

const DEPLOY_OPTIONS: DeployOption[] = [
  {
    href: 'https://github.com/agentworkforce/relay/blob/main/docs/self-hosting/README.md',
    label: 'Read the Agent Relay self-hosting README on GitHub',
    icon: <MonitorIcon />,
    title: 'Self host',
    text: 'For teams that need complete control.',
  },
  {
    href: 'https://agentrelay.com/cloud',
    label: 'Open Agent Relay hosted cloud',
    icon: <CloudIcon />,
    title: 'Hosted cloud',
    text: 'For teams that just want to build.',
  },
];

export function Deploy() {
  return (
    <section className={s.deploySection}>
      <FadeIn direction="up">
        <h2 className={s.deployTitle}>Open source from day one</h2>
        <p className={s.deploySubtitle}>
          Use the open-source engine in your own infrastructure, or let us run it for you with a generous free
          tier.
        </p>
      </FadeIn>
      <FadeIn direction="up" delay={150}>
        <div className={s.deployCards}>
          {DEPLOY_OPTIONS.map((option) => (
            <a
              key={option.title}
              href={option.href}
              target="_blank"
              rel="noopener noreferrer"
              className={s.deployCard}
              aria-label={option.label}
            >
              <div className={s.deployIcon}>{option.icon}</div>
              <h3 className={s.deployCardTitle}>{option.title}</h3>
              <p className={s.deployCardText}>{option.text}</p>
            </a>
          ))}
        </div>
      </FadeIn>
    </section>
  );
}
