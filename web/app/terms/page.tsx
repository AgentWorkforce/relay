import type { Metadata } from 'next';
import Link from 'next/link';

import { GitHubStarsBadge } from '../../components/GitHubStars';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteNav } from '../../components/SiteNav';
import { absoluteUrl, SITE_EMAIL } from '../../lib/site';
import s from '../legal.module.css';

export const metadata: Metadata = {
  title: 'Terms of Service - Agent Relay',
  description:
    'The terms that apply when using the Agent Relay website, open-source tools, hosted cloud services, and integrations.',
  alternates: {
    canonical: absoluteUrl('/terms'),
  },
};

export default function TermsPage() {
  return (
    <div className={s.page}>
      <SiteNav actions={<GitHubStarsBadge />} />

      <main className={s.content}>
        <p className={s.meta}>Last updated: May 27, 2026</p>
        <h1 className={s.title}>Terms of Service</h1>
        <p className={s.subtitle}>
          These terms govern access to Agent Relay websites, open-source tools, hosted cloud services, and
          integrations. By using Agent Relay, you agree to these terms.
        </p>

        <section className={s.section}>
          <h2>Agreement</h2>
          <p>
            These Terms of Service are an agreement between you and Agent Workforce for use of Agent Relay.
            If you use Agent Relay on behalf of an organization, you represent that you have authority to bind
            that organization to these terms.
          </p>
          <p>
            Agent Relay also processes information as described in our{' '}
            <Link href="/privacy" className={s.link}>
              Privacy Policy
            </Link>
            .
          </p>
        </section>

        <section className={s.section}>
          <h2>Services</h2>
          <p>
            Agent Relay provides software and hosted services for coordinating agents, messages, files,
            workflows, cloud workspaces, repository integrations, and related developer operations. Some
            features are open source and may run locally. Other features require an Agent Relay Cloud account
            or a paid plan.
          </p>
        </section>

        <section className={s.section}>
          <h2>Accounts and access</h2>
          <ul className={s.list}>
            <li>You are responsible for keeping account credentials and API tokens secure.</li>
            <li>You are responsible for activity under your account, workspace, organization, or integration.</li>
            <li>You must provide accurate account, billing, and contact information when required.</li>
            <li>You may not share access in a way that bypasses plan limits or security controls.</li>
          </ul>
        </section>

        <section className={s.section}>
          <h2>Acceptable use</h2>
          <p>You may not use Agent Relay to:</p>
          <ul className={s.list}>
            <li>Violate laws, regulations, third-party rights, or provider terms.</li>
            <li>Access systems, repositories, services, or data without authorization.</li>
            <li>Transmit malware, abuse infrastructure, disrupt services, or evade rate limits.</li>
            <li>Generate, coordinate, or automate harmful, deceptive, or abusive activity.</li>
            <li>Reverse engineer hosted services except where allowed by law or an open-source license.</li>
            <li>Remove notices, misuse branding, or imply endorsement without permission.</li>
          </ul>
        </section>

        <section className={s.section}>
          <h2>Your content</h2>
          <p>
            You retain ownership of source code, prompts, messages, files, repository content, Slack
            messages, issue text, pull request text, agent output, and other content you provide or connect.
            You grant Agent Relay the rights needed to process that content to provide, secure, and improve
            the services.
          </p>
          <p>
            You are responsible for ensuring that you have the rights and permissions needed to submit,
            connect, or process content through Agent Relay and its integrations.
          </p>
        </section>

        <section className={s.section}>
          <h2>Integrations</h2>
          <p>
            Agent Relay can connect to third-party services such as GitHub, Slack, Google services, Nango,
            Stripe, and infrastructure providers. Your use of those services remains subject to their terms.
            You are responsible for the permissions, scopes, repositories, channels, workspaces, and accounts
            you authorize.
          </p>
          <p>
            You may disconnect integrations at any time, but doing so may limit or disable related Agent
            Relay features.
          </p>
        </section>

        <section className={s.section}>
          <h2>Cloud workspaces and agents</h2>
          <p>
            Hosted workspaces may run commands, clone repositories, call connected APIs, produce messages,
            create branches, open pull requests, or otherwise act based on your configuration and
            instructions. You are responsible for reviewing agent actions and configuring appropriate access,
            policies, approvals, and repository permissions.
          </p>
        </section>

        <section className={s.section}>
          <h2>Billing</h2>
          <p>
            Paid services are billed according to the plan, usage, interval, and payment terms shown at
            checkout or in the product. Subscription fees are non-refundable except where required by law or
            expressly stated otherwise. We may suspend or limit paid features if payment fails or usage
            exceeds applicable limits.
          </p>
        </section>

        <section className={s.section}>
          <h2>Open-source software</h2>
          <p>
            Agent Relay includes open-source software governed by the licenses included with that software.
            These terms do not limit rights granted under applicable open-source licenses. Hosted services,
            cloud infrastructure, branding, and non-public systems are not open-source software unless
            expressly stated.
          </p>
        </section>

        <section className={s.section}>
          <h2>Service changes</h2>
          <p>
            We may add, remove, suspend, or change features, plans, integrations, limits, or infrastructure.
            We may suspend access when needed to protect users, systems, providers, or the integrity of Agent
            Relay.
          </p>
        </section>

        <section className={s.section}>
          <h2>Disclaimers</h2>
          <p>
            Agent Relay is provided "as is" and "as available" to the maximum extent permitted by law. We do
            not warrant that the services will be uninterrupted, error-free, secure, or that agent-generated
            output will be accurate, complete, or suitable for any particular purpose.
          </p>
        </section>

        <section className={s.section}>
          <h2>Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, Agent Workforce will not be liable for indirect,
            incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenue,
            data, goodwill, or business opportunities arising from your use of Agent Relay.
          </p>
        </section>

        <section className={s.section}>
          <h2>Termination</h2>
          <p>
            You may stop using Agent Relay at any time. We may suspend or terminate access if you violate
            these terms, create risk for the service or other users, fail to pay required fees, or use the
            service in a way that could cause legal or operational harm.
          </p>
        </section>

        <section className={s.section}>
          <h2>Changes to these terms</h2>
          <p>
            We may update these terms as Agent Relay changes. When we make material changes, we will update
            the date above and provide additional notice when appropriate. Continued use after changes means
            you accept the updated terms.
          </p>
        </section>

        <section className={s.section}>
          <h2>Contact</h2>
          <p>
            Questions about these terms can be sent to{' '}
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
