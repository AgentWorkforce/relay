import type { Metadata } from 'next';

import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { absoluteUrl } from '../../lib/site';
import s from './telemetry.module.css';

export const metadata: Metadata = {
  title: 'Telemetry — Agent Relay',
  description: 'What anonymous usage data Agent Relay collects, why, and how to opt out.',
  alternates: {
    canonical: absoluteUrl('/telemetry'),
  },
};

export default function TelemetryPage() {
  return (
    <div className={s.page}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <main className={s.content}>
        <h1 className={s.title}>Telemetry</h1>
        <p className={s.subtitle}>
          Agent Relay collects anonymous usage data to help us improve the product. This page explains what we
          collect, why, and how to opt out.
        </p>

        <section className={s.section}>
          <h2>Opt out anytime</h2>
          <p>
            Telemetry is <strong>on by default</strong> but can be disabled instantly:
          </p>
          <pre className={s.code}>
            <code>agent-relay telemetry disable</code>
          </pre>
          <p>Or set the environment variable:</p>
          <pre className={s.code}>
            <code>export AGENT_RELAY_TELEMETRY_DISABLED=1</code>
          </pre>
          <p>
            Agent Relay also honors the{' '}
            <a
              href="https://consoledonottrack.com"
              target="_blank"
              rel="noopener noreferrer"
              className={s.link}
            >
              <code>DO_NOT_TRACK</code>
            </a>{' '}
            convention for opting out across compatible tools:
          </p>
          <pre className={s.code}>
            <code>export DO_NOT_TRACK=1</code>
          </pre>
          <p>To re-enable:</p>
          <pre className={s.code}>
            <code>agent-relay telemetry enable</code>
          </pre>
          <p>Check your current status:</p>
          <pre className={s.code}>
            <code>agent-relay telemetry</code>
          </pre>
        </section>

        <section className={s.section}>
          <h2>What we collect</h2>
          <p>
            Every event includes these <strong>common properties</strong>:
          </p>
          <div className={s.tableWrapper}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Example</th>
                  <th>Purpose</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>agent_relay_version</code>
                  </td>
                  <td>3.2.22</td>
                  <td>Know which versions are in use</td>
                </tr>
                <tr>
                  <td>
                    <code>os</code>
                  </td>
                  <td>darwin</td>
                  <td>Platform-specific bug triage</td>
                </tr>
                <tr>
                  <td>
                    <code>arch</code>
                  </td>
                  <td>arm64</td>
                  <td>Binary distribution decisions</td>
                </tr>
                <tr>
                  <td>
                    <code>node_version</code>
                  </td>
                  <td>20.11.0</td>
                  <td>Runtime compatibility</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p>These events are collected:</p>

          <div className={s.tableWrapper}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>When</th>
                  <th>Extra properties</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>broker_start</code>
                  </td>
                  <td>Broker process starts</td>
                  <td>None</td>
                </tr>
                <tr>
                  <td>
                    <code>broker_stop</code>
                  </td>
                  <td>Broker shuts down</td>
                  <td>Uptime, agent count</td>
                </tr>
                <tr>
                  <td>
                    <code>agent_spawn</code>
                  </td>
                  <td>An agent is created</td>
                  <td>CLI type, spawn source, has task, is shadow</td>
                </tr>
                <tr>
                  <td>
                    <code>agent_release</code>
                  </td>
                  <td>An agent is stopped</td>
                  <td>CLI type, reason, lifetime, source</td>
                </tr>
                <tr>
                  <td>
                    <code>agent_crash</code>
                  </td>
                  <td>An agent exits unexpectedly</td>
                  <td>CLI type, lifetime, exit code</td>
                </tr>
                <tr>
                  <td>
                    <code>message_send</code>
                  </td>
                  <td>A relay message is sent</td>
                  <td>Is broadcast, has thread</td>
                </tr>
                <tr>
                  <td>
                    <code>cli_command_run</code>
                  </td>
                  <td>A CLI command is executed</td>
                  <td>Command name</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className={s.section}>
          <h2>What we do not collect</h2>
          <ul className={s.list}>
            <li>Source code, file paths, or repository content</li>
            <li>Message text, task descriptions, or prompts</li>
            <li>API keys, tokens, or credentials</li>
            <li>Agent names or workspace names</li>
            <li>IP addresses (geo-IP is coarsened to country level by PostHog)</li>
            <li>Any personally identifiable information</li>
          </ul>
        </section>

        <section className={s.section}>
          <h2>How it works</h2>
          <ul className={s.list}>
            <li>
              A <strong>random anonymous ID</strong> is generated from your machine ID on first run. It cannot
              be traced back to you.
            </li>
            <li>
              Events are sent to <strong>PostHog</strong> (our analytics provider) over HTTPS.
            </li>
            <li>
              Preferences are stored locally at <code>~/.agent-relay/telemetry.json</code>.
            </li>
            <li>
              The telemetry module is designed to be <strong>infallible</strong> &mdash; if anything fails, it
              silently no-ops. Telemetry never affects CLI functionality.
            </li>
          </ul>
        </section>

        <section className={s.section}>
          <h2>Why we collect telemetry</h2>
          <p>
            Agent Relay is a developer tool. Telemetry helps us understand which CLI providers are popular,
            how long agent sessions last, where crashes happen, and which commands are used. This data
            directly informs what we build and fix next.
          </p>
        </section>

        <section className={s.section}>
          <h2>Source code</h2>
          <p>
            The telemetry implementation is fully open source. You can inspect exactly what is collected:{' '}
            <a
              href="https://github.com/AgentWorkforce/relay/tree/main/packages/telemetry"
              target="_blank"
              rel="noopener noreferrer"
              className={s.link}
            >
              packages/telemetry
            </a>
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
