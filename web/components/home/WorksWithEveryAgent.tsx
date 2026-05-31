import { AGENT_TOOL_LABELS, AGENT_TOOLS, AgentToolLogo } from '../AgentToolLogos';
import { FadeIn } from '../FadeIn';
import s from '../../app/landing.module.css';

export function WorksWithEveryAgent() {
  return (
    <div className={`${s.byohWrapper} ${s.featureByoh}`}>
      <section className={s.byohSection}>
        <FadeIn direction="up" className={s.byohText}>
          <h2 className={s.byohTitle}>Works with every agent</h2>
          <p className={s.byohSubtitle}>
            It's not a harness, and it's not a framework. You can plug in directly with our first class
            adapters or you can define your own.
          </p>
        </FadeIn>
        <FadeIn direction="up" delay={200} className={s.byohLogos}>
          {AGENT_TOOLS.map((provider) => (
            <div key={provider} className={s.logoCard}>
              <AgentToolLogo className={s.byohLogo} idPrefix={`byoh-agent-${provider}`} provider={provider} />
              <span className={s.logoLabel}>{AGENT_TOOL_LABELS[provider]}</span>
            </div>
          ))}
        </FadeIn>
        <p className={s.byohFootnote}>or any other agent that you hook up </p>
      </section>
    </div>
  );
}
