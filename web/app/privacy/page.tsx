import type { Metadata } from 'next';
import Link from 'next/link';

import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { absoluteUrl, SITE_EMAIL } from '../../lib/site';
import s from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Privacy Policy - Agent Relay',
  description:
    'How Agent Relay collects, uses, and protects information for the website, open-source tools, and cloud services.',
  alternates: {
    canonical: absoluteUrl('/privacy'),
  },
};

export default function PrivacyPage() {
  return (
    <div className={s.page}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <main className={s.content}>
        <p className={s.meta}>Last updated: May 27, 2026</p>
        <h1 className={s.title}>Privacy Policy</h1>
        <p className={s.subtitle}>
          Agent Relay is infrastructure for agents that communicate and coordinate work. This policy explains
          what information we collect through agentrelay.com, the open-source Agent Relay tools, and hosted
          Agent Relay Cloud services.
        </p>

        <section className={s.section}>
          <h2>Scope</h2>
          <p>
            This policy applies to Agent Relay products and services operated by Agent Workforce, including
            the Agent Relay website, CLI telemetry, hosted cloud workspaces, integrations, billing, and
            support communications. Open-source use of Agent Relay can run locally without an Agent Relay
            Cloud account.
          </p>
        </section>

        <section className={s.section}>
          <h2>Information we collect</h2>
          <div className={s.tableWrapper}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Examples</th>
                  <th>Why we use it</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Account</td>
                  <td>
                    Email address, display name, GitHub username, GitHub ID, avatar URL, plan, verification
                    status
                  </td>
                  <td>
                    Create accounts, authenticate users, manage plans, and show profile context in the product
                  </td>
                </tr>
                <tr>
                  <td>Cloud workspaces</td>
                  <td>
                    Workspace names, status, compute provider IDs, public URLs, custom domains, team
                    memberships
                  </td>
                  <td>Provision, operate, secure, and troubleshoot hosted agent workspaces</td>
                </tr>
                <tr>
                  <td>Repositories and projects</td>
                  <td>
                    Repository full names, GitHub repository IDs, default branches, private/public status,
                    project group settings
                  </td>
                  <td>
                    Connect workspaces to repositories, route agent work, and maintain project configuration
                  </td>
                </tr>
                <tr>
                  <td>Agent activity</td>
                  <td>
                    Agent names, session status, summaries, end markers, memory metrics, crash details,
                    alerts, queued message metadata
                  </td>
                  <td>
                    Run cloud agents, preserve session context when enabled, diagnose failures, and deliver
                    requested work
                  </td>
                </tr>
                <tr>
                  <td>Integrations</td>
                  <td>
                    GitHub App installation IDs, granted permissions, provider account IDs, scopes, Slack
                    team/channel/thread/user IDs
                  </td>
                  <td>Connect Agent Relay to GitHub, Slack, and other services you authorize</td>
                </tr>
                <tr>
                  <td>Billing and usage</td>
                  <td>
                    Stripe customer and subscription IDs, plan status, invoice references, usage metrics
                  </td>
                  <td>
                    Process subscriptions, enforce limits, prepare invoices, and support billing questions
                  </td>
                </tr>
                <tr>
                  <td>Website and telemetry</td>
                  <td>
                    Page views, browser information, coarse location, CLI version, operating system, command
                    names
                  </td>
                  <td>Understand product usage, improve reliability, and prioritize fixes</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            The CLI telemetry collected by the open-source tool is described separately on the{' '}
            <Link href="/telemetry" className={s.link}>
              telemetry page
            </Link>
            , including how to opt out.
          </p>
        </section>

        <section className={s.section}>
          <h2>Content you provide</h2>
          <p>
            Agent Relay may process source code, repository content, prompts, messages, files, issue text,
            pull request text, Slack messages, and agent output when you connect repositories or integrations
            and ask agents to work on them. Hosted workspaces need access to that content to perform the
            actions you request.
          </p>
          <p>
            Cloud session persistence features may store structured summaries, decisions, completed tasks,
            file references, and other context emitted by agents. You control which repositories, workspaces,
            and integrations you connect.
          </p>
        </section>

        <section className={s.section}>
          <h2>How we use information</h2>
          <ul className={s.list}>
            <li>Provide, maintain, and secure Agent Relay services</li>
            <li>Authenticate users and manage sessions, teams, and permissions</li>
            <li>Provision and operate hosted workspaces and connected integrations</li>
            <li>Route messages, tasks, approvals, and agent activity across workspaces</li>
            <li>Process subscriptions, usage limits, invoices, and billing support</li>
            <li>Debug failures, detect abuse, improve reliability, and develop new features</li>
            <li>Communicate about service updates, support requests, and account notices</li>
          </ul>
        </section>

        <section className={s.section}>
          <h2>Integrations and service providers</h2>
          <p>
            Agent Relay uses third-party services to operate the product. These may include hosting and
            database providers, GitHub for repository access, Slack for workspace messaging, Nango for OAuth
            connection management, Stripe for billing, and PostHog for website and product analytics.
          </p>
          <p>
            OAuth tokens and provider credentials are handled according to the integration flow you authorize.
            Agent Relay Cloud stores provider connection metadata and may use workspace-local credentials or
            provider-managed token storage to perform requested actions.
          </p>
        </section>

        <section className={s.section}>
          <h2>How we share information</h2>
          <p>
            We do not sell personal information. We share information with service providers only as needed to
            operate Agent Relay, with integrations you connect, as directed by workspace administrators, to
            comply with law, or to protect the security and integrity of the service.
          </p>
        </section>

        <section className={s.section}>
          <h2>Security and retention</h2>
          <p>
            We use technical and organizational safeguards designed to protect the information processed by
            Agent Relay. No system is perfectly secure, so you should connect only the repositories,
            workspaces, and integrations needed for your work.
          </p>
          <p>
            We retain information for as long as needed to provide the service, comply with legal obligations,
            resolve disputes, enforce agreements, preserve security records, and maintain backups. Some
            operational logs and audit records may be retained after account or workspace deletion where
            required for security, billing, or compliance.
          </p>
        </section>

        <section className={s.section}>
          <h2>Your choices</h2>
          <ul className={s.list}>
            <li>Disable CLI telemetry by following the instructions on the telemetry page.</li>
            <li>
              Disconnect GitHub, Slack, or other integrations from the relevant provider or Agent Relay
              settings.
            </li>
            <li>Delete workspaces and repositories you no longer want Agent Relay Cloud to operate on.</li>
            <li>Use local open-source Agent Relay workflows when you do not need hosted cloud services.</li>
            <li>Contact us to request access, correction, export, or deletion of account information.</li>
          </ul>
        </section>

        <section className={s.section}>
          <h2>International users</h2>
          <p>
            Agent Relay is operated from the United States and may process information in the United States or
            other countries where our providers operate. By using the service, you understand that information
            may be transferred outside your country of residence.
          </p>
        </section>

        <section className={s.section}>
          <h2>Changes</h2>
          <p>
            We may update this policy as Agent Relay changes. When we make material changes, we will update
            the date above and provide additional notice when appropriate.
          </p>
        </section>

        <section className={s.section}>
          <h2>Contact</h2>
          <p>
            Questions or privacy requests can be sent to{' '}
            <a href={`mailto:${SITE_EMAIL}`} className={s.link}>
              {SITE_EMAIL}
            </a>
            .
          </p>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
