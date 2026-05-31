import { AGENT_TOOL_LABELS, AGENT_TOOLS, AgentToolLogo } from '../AgentToolLogos';
import { AgentSetupPrompt, InstallCommand } from '../InstallCommand';
import s from '../../app/landing.module.css';

export function QuickStart() {
  return (
    <section className={s.installSection} aria-labelledby="install-title">
      <div className={s.installInner}>
        <div className={s.installHeader}>
          <div className={s.installHeaderText}>
            <div className={s.installTitleRow}>
              <h2 id="install-title" className={s.installTitle}>
                Quick start
              </h2>

              <div className={s.installAgentLogos} aria-label="Get started with the agents you already use">
                {AGENT_TOOLS.map((provider) => (
                  <span
                    key={provider}
                    className={s.installAgentLogo}
                    aria-label={AGENT_TOOL_LABELS[provider]}
                    title={AGENT_TOOL_LABELS[provider]}
                  >
                    <AgentToolLogo
                      className={s.installAgentLogoIcon}
                      idPrefix={`install-agent-${provider}`}
                      provider={provider}
                    />
                  </span>
                ))}
                <span className={s.installAgentTooltip}>
                  Works with the harnesses you already love or integrate your own.
                </span>
              </div>
            </div>

            <p className={s.installSubtitle}>
              Human or agent, sometimes it's just <i>easier</i> to start building with stuff to figure out if
              it's useful. Fortunately, we've made that really easy for both.
            </p>
          </div>
        </div>

        <div className={s.installActions}>
          <InstallCommand />
          <AgentSetupPrompt />
        </div>
      </div>
    </section>
  );
}
