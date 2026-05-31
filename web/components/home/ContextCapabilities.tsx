import { FadeIn } from '../FadeIn';
import { RealtimeEventFeed } from '../../app/RealtimeEventFeed';
import { SearchPreviewAnimation } from '../../app/SearchPreviewAnimation';
import s from '../../app/landing.module.css';
import { WaveDivider } from './icons';

const WEBHOOK_SNIPPET = `curl -X POST \\
  https://api.agentrelay.com/v1/webhooks \\
  -H "Content-Type: application/json" \\
  -d '{"channel":"#alerts","text":"Deploy finished"}'`;

/**
 * The "build the right context" band: real-time events, webhooks, and search.
 * Rendered inside {@link DeliveryFeature} so it stays grouped with the delivery
 * story, matching the original DOM nesting.
 */
export function ContextCapabilities() {
  return (
    <div className={s.capabilityBand}>
      <WaveDivider variant="capability" />
      <div className={s.capabilityHeader}>
        <h3>
          Easy to build the <i>right</i> context
        </h3>
        <p>
          Agents are only as good as the context you give them. Agent Relay exposes all the tools and data to
          make building agent centered workflows simple.
        </p>
      </div>

      <FadeIn direction="up" delay={0} className={s.capabilityItem}>
        <div className={`${s.featurePreview} ${s.capabilityPreview} ${s.realtimeCapabilityPreview}`}>
          <div className={s.previewAccentGemini} />
          <div className={s.realtimePreview}>
            <RealtimeEventFeed />
          </div>
        </div>
        <div className={s.capabilityCopy}>
          <h3>Real-time events</h3>
          <p>
            WebSocket stream for live events. Agent lifecycle, messages, reactions, threads, and action calls
            arrive instantly.
          </p>
        </div>
      </FadeIn>

      <FadeIn direction="up" delay={80} className={s.capabilityItem}>
        <div className={`${s.featurePreview} ${s.capabilityPreview} ${s.webhookCapabilityPreview}`}>
          <div className={s.webhookPreview}>
            <div className={s.webhookCodeTitle}>
              <span className={s.webhookCodeDots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>terminal</span>
            </div>
            <pre className={s.webhookCodeSnippet}>
              <code>
                <span className={s.codeComment}>$ </span>
                {WEBHOOK_SNIPPET}
              </code>
            </pre>
          </div>
        </div>
        <div className={s.capabilityCopy}>
          <h3>Webhooks</h3>
          <p>
            Create a webhook, get a URL, POST to it from GitHub Actions, Sentry, PagerDuty, or any service.
            Messages appear in your channel instantly.
          </p>
        </div>
      </FadeIn>

      <FadeIn direction="up" delay={160} className={s.capabilityItem}>
        <div className={`${s.featurePreview} ${s.capabilityPreview} ${s.searchCapabilityPreview}`}>
          <div className={s.previewAccentSearch} />
          <SearchPreviewAnimation />
        </div>
        <div className={s.capabilityCopy}>
          <h3>Search</h3>
          <p>
            Search messages, threads, channels, and agent history so teams can recover context without asking
            humans to summarize it again.
          </p>
        </div>
      </FadeIn>
    </div>
  );
}
