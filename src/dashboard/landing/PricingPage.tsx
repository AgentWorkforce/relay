/**
 * Agent Relay Cloud - Pricing Page
 *
 * Dedicated pricing page with detailed plan comparison,
 * feature matrix, and FAQ section.
 *
 * Aesthetic: Mission Control / Command Center (matches landing page)
 */

import React, { useState, useEffect } from 'react';
import { LogoIcon } from '../react-components/Logo';

// Plan data with full details
const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: 0,
    period: 'forever',
    tagline: 'Try it out on a side project',
    description: 'Perfect for exploring AI agent orchestration on personal projects.',
    limits: {
      workspaces: 1,
      repos: 3,
      concurrentAgents: 2,
      computeHours: 10,
    },
    features: [
      { name: 'Workspaces', value: '1', included: true },
      { name: 'Repositories', value: '3', included: true },
      { name: 'Concurrent agents', value: '2', included: true },
      { name: 'Compute hours/month', value: '10', included: true },
      { name: 'Coordinator agents', value: null, included: false },
      { name: 'Team collaboration', value: null, included: false },
      { name: 'Priority support', value: null, included: false },
      { name: 'Audit logs', value: null, included: false },
      { name: 'SSO/SAML', value: null, included: false },
      { name: 'SLA guarantee', value: null, included: false },
    ],
    cta: 'Get Started Free',
    ctaLink: '/signup',
    highlighted: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 29,
    period: '/month',
    tagline: 'For professional developers',
    description: 'Unlock coordinator agents and scale your AI workforce.',
    limits: {
      workspaces: 5,
      repos: 20,
      concurrentAgents: 10,
      computeHours: 100,
    },
    features: [
      { name: 'Workspaces', value: '5', included: true },
      { name: 'Repositories', value: '20', included: true },
      { name: 'Concurrent agents', value: '10', included: true },
      { name: 'Compute hours/month', value: '100', included: true },
      { name: 'Coordinator agents', value: 'Yes', included: true },
      { name: 'Team collaboration', value: null, included: false },
      { name: 'Priority support', value: null, included: false },
      { name: 'Audit logs', value: null, included: false },
      { name: 'SSO/SAML', value: null, included: false },
      { name: 'SLA guarantee', value: null, included: false },
    ],
    cta: 'Start Free Trial',
    ctaLink: '/signup?plan=pro',
    highlighted: true,
    badge: 'Most Popular',
  },
  {
    id: 'team',
    name: 'Team',
    price: 99,
    period: '/month',
    tagline: 'For growing teams',
    description: 'Collaborate with your team and ship faster together.',
    limits: {
      workspaces: 20,
      repos: 100,
      concurrentAgents: 50,
      computeHours: 500,
    },
    features: [
      { name: 'Workspaces', value: '20', included: true },
      { name: 'Repositories', value: '100', included: true },
      { name: 'Concurrent agents', value: '50', included: true },
      { name: 'Compute hours/month', value: '500', included: true },
      { name: 'Coordinator agents', value: 'Yes', included: true },
      { name: 'Team collaboration', value: 'Yes', included: true },
      { name: 'Priority support', value: 'Yes', included: true },
      { name: 'Audit logs', value: 'Yes', included: true },
      { name: 'SSO/SAML', value: null, included: false },
      { name: 'SLA guarantee', value: null, included: false },
    ],
    cta: 'Start Free Trial',
    ctaLink: '/signup?plan=team',
    highlighted: false,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: null,
    period: '',
    tagline: 'For organizations at scale',
    description: 'Custom solutions with dedicated support and SLA guarantees.',
    limits: {
      workspaces: Infinity,
      repos: Infinity,
      concurrentAgents: Infinity,
      computeHours: Infinity,
    },
    features: [
      { name: 'Workspaces', value: 'Unlimited', included: true },
      { name: 'Repositories', value: 'Unlimited', included: true },
      { name: 'Concurrent agents', value: 'Unlimited', included: true },
      { name: 'Compute hours/month', value: 'Unlimited', included: true },
      { name: 'Coordinator agents', value: 'Yes', included: true },
      { name: 'Team collaboration', value: 'Yes', included: true },
      { name: 'Priority support', value: 'Dedicated', included: true },
      { name: 'Audit logs', value: 'Yes', included: true },
      { name: 'SSO/SAML', value: 'Yes', included: true },
      { name: 'SLA guarantee', value: '99.9%', included: true },
    ],
    cta: 'Contact Sales',
    ctaLink: '/contact?subject=enterprise',
    highlighted: false,
  },
];

const FAQ = [
  {
    q: 'What counts as a "compute hour"?',
    a: 'A compute hour is measured when your agents are actively running in our cloud infrastructure. Time spent waiting for your input or idle time doesn\'t count. We track usage to the second and round up to the nearest minute for billing.',
  },
  {
    q: 'Can I use my own AI API keys?',
    a: 'Yes! Agent Relay orchestrates your agents—you connect your own Claude, Codex, or Gemini instances. We don\'t charge for AI API usage; that\'s between you and your AI provider. Our pricing covers the orchestration infrastructure.',
  },
  {
    q: 'What are coordinator agents?',
    a: 'Coordinators are special agents that oversee project groups. They delegate tasks to other agents, track progress, and ensure work is completed efficiently across multiple repositories. Available on Pro plans and above.',
  },
  {
    q: 'What happens if I exceed my limits?',
    a: 'We\'ll notify you when you\'re approaching your limits. If you exceed them, new agent spawns will be blocked until you upgrade or wait for the next billing cycle. Your existing agents will continue running.',
  },
  {
    q: 'Can I change plans anytime?',
    a: 'Absolutely. Upgrade instantly and get prorated billing. Downgrade takes effect at the end of your billing cycle. No long-term contracts required.',
  },
  {
    q: 'Do you offer discounts for startups or open source?',
    a: 'Yes! We offer 50% off for verified startups (less than $1M raised) and free Pro accounts for maintainers of popular open source projects. Contact us to apply.',
  },
];

export function PricingPage() {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div className="pricing-page">
      <div className="pricing-bg">
        <GridBackground />
        <GlowOrbs />
      </div>

      <Navigation />

      <main>
        <HeroSection billingCycle={billingCycle} setBillingCycle={setBillingCycle} />
        <PlansSection billingCycle={billingCycle} />
        <ComparisonTable />
        <FaqSection openFaq={openFaq} setOpenFaq={setOpenFaq} />
        <CtaSection />
      </main>

      <Footer />
    </div>
  );
}

function Navigation() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <nav className={`nav ${scrolled ? 'scrolled' : ''}`}>
      <div className="nav-inner">
        <a href="/" className="nav-logo">
          <LogoIcon size={28} withGlow={true} />
          <span className="logo-text">Agent Relay</span>
        </a>

        <div className="nav-links">
          <a href="/#demo">Demo</a>
          <a href="/#features">Features</a>
          <a href="/pricing" className="active">Pricing</a>
          <a href="/docs" className="nav-docs">Docs</a>
        </div>

        <div className="nav-actions">
          <a href="/login" className="btn-ghost">Sign In</a>
          <a href="/signup" className="btn-primary">Get Started</a>
        </div>
      </div>
    </nav>
  );
}

function HeroSection({
  billingCycle,
  setBillingCycle
}: {
  billingCycle: 'monthly' | 'annual';
  setBillingCycle: (cycle: 'monthly' | 'annual') => void;
}) {
  return (
    <section className="pricing-hero">
      <div className="pricing-hero-content">
        <div className="hero-badge">
          <span className="badge-icon">◈</span>
          <span>Simple, transparent pricing</span>
        </div>

        <h1>
          <span className="title-line">Choose Your</span>
          <span className="title-line gradient">Mission Control</span>
        </h1>

        <p className="hero-subtitle">
          Start free. Scale as you grow. Pay only for what you use.
          <br />
          All plans include a 14-day free trial.
        </p>

        <div className="billing-toggle">
          <button
            className={billingCycle === 'monthly' ? 'active' : ''}
            onClick={() => setBillingCycle('monthly')}
          >
            Monthly
          </button>
          <button
            className={billingCycle === 'annual' ? 'active' : ''}
            onClick={() => setBillingCycle('annual')}
          >
            Annual
            <span className="save-badge">Save 20%</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function PlansSection({ billingCycle }: { billingCycle: 'monthly' | 'annual' }) {
  const getPrice = (plan: typeof PLANS[0]) => {
    if (plan.price === null) return 'Custom';
    if (plan.price === 0) return '$0';
    const price = billingCycle === 'annual' ? Math.floor(plan.price * 0.8) : plan.price;
    return `$${price}`;
  };

  return (
    <section className="plans-section">
      <div className="plans-grid">
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            className={`plan-card ${plan.highlighted ? 'highlighted' : ''}`}
          >
            {plan.badge && <div className="plan-badge">{plan.badge}</div>}

            <div className="plan-header">
              <h3>{plan.name}</h3>
              <p className="plan-tagline">{plan.tagline}</p>
            </div>

            <div className="plan-price">
              <span className="price">{getPrice(plan)}</span>
              {plan.price !== null && plan.price > 0 && (
                <span className="period">
                  {billingCycle === 'annual' ? '/mo, billed annually' : '/month'}
                </span>
              )}
              {plan.price === 0 && <span className="period">forever</span>}
            </div>

            <p className="plan-description">{plan.description}</p>

            <div className="plan-limits">
              <div className="limit-item">
                <span className="limit-icon">◇</span>
                <span className="limit-value">{plan.limits.workspaces === Infinity ? '∞' : plan.limits.workspaces}</span>
                <span className="limit-label">workspaces</span>
              </div>
              <div className="limit-item">
                <span className="limit-icon">◈</span>
                <span className="limit-value">{plan.limits.repos === Infinity ? '∞' : plan.limits.repos}</span>
                <span className="limit-label">repos</span>
              </div>
              <div className="limit-item">
                <span className="limit-icon">⬡</span>
                <span className="limit-value">{plan.limits.concurrentAgents === Infinity ? '∞' : plan.limits.concurrentAgents}</span>
                <span className="limit-label">agents</span>
              </div>
              <div className="limit-item">
                <span className="limit-icon">⏱</span>
                <span className="limit-value">{plan.limits.computeHours === Infinity ? '∞' : plan.limits.computeHours}</span>
                <span className="limit-label">hours/mo</span>
              </div>
            </div>

            <a
              href={plan.ctaLink}
              className={`btn-${plan.highlighted ? 'primary' : 'ghost'} btn-full`}
            >
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

function ComparisonTable() {
  const featureNames = PLANS[0].features.map(f => f.name);

  return (
    <section className="comparison-section">
      <div className="section-header">
        <span className="section-tag">Compare Plans</span>
        <h2>Feature Comparison</h2>
        <p>See exactly what's included in each plan.</p>
      </div>

      <div className="comparison-table-wrapper">
        <table className="comparison-table">
          <thead>
            <tr>
              <th className="feature-col">Feature</th>
              {PLANS.map(plan => (
                <th key={plan.id} className={plan.highlighted ? 'highlighted' : ''}>
                  {plan.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {featureNames.map((featureName, i) => (
              <tr key={featureName}>
                <td className="feature-col">{featureName}</td>
                {PLANS.map(plan => {
                  const feature = plan.features[i];
                  return (
                    <td key={plan.id} className={plan.highlighted ? 'highlighted' : ''}>
                      {feature.included ? (
                        feature.value ? (
                          <span className="feature-value">{feature.value}</span>
                        ) : (
                          <span className="check">✓</span>
                        )
                      ) : (
                        <span className="dash">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FaqSection({
  openFaq,
  setOpenFaq
}: {
  openFaq: number | null;
  setOpenFaq: (index: number | null) => void;
}) {
  return (
    <section className="faq-section">
      <div className="section-header">
        <span className="section-tag">FAQ</span>
        <h2>Questions? Answers.</h2>
        <p>Everything you need to know about Agent Relay pricing.</p>
      </div>

      <div className="faq-grid">
        {FAQ.map((item, i) => (
          <div
            key={i}
            className={`faq-item ${openFaq === i ? 'open' : ''}`}
            onClick={() => setOpenFaq(openFaq === i ? null : i)}
          >
            <div className="faq-question">
              <span>{item.q}</span>
              <span className="faq-toggle">{openFaq === i ? '−' : '+'}</span>
            </div>
            <div className="faq-answer">
              <p>{item.a}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CtaSection() {
  return (
    <section className="cta-section">
      <div className="cta-card">
        <div className="cta-content">
          <h2>Ready to orchestrate?</h2>
          <p>Start free and upgrade when you need more power.</p>
          <div className="cta-buttons">
            <a href="/signup" className="btn-primary btn-large">
              <span>Get Started Free</span>
              <span className="btn-arrow">→</span>
            </a>
            <a href="/contact" className="btn-ghost btn-large">
              Talk to Sales
            </a>
          </div>
        </div>
        <div className="cta-visual">
          <div className="orbit">
            <div className="orbit-ring ring-1" />
            <div className="orbit-ring ring-2" />
            <div className="orbit-ring ring-3" />
            <div className="orbit-center">
              <LogoIcon size={40} withGlow={true} />
            </div>
            <div className="orbit-dot dot-1">◈</div>
            <div className="orbit-dot dot-2">⬡</div>
            <div className="orbit-dot dot-3">◇</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <a href="/" className="footer-logo">
            <LogoIcon size={24} withGlow={true} />
            <span className="logo-text">Agent Relay</span>
          </a>
          <p>Orchestrate AI agents like a symphony.</p>
        </div>

        <div className="footer-links">
          <div className="footer-column">
            <h4>Product</h4>
            <a href="/#features">Features</a>
            <a href="/pricing">Pricing</a>
            <a href="/docs">Documentation</a>
            <a href="/changelog">Changelog</a>
          </div>
          <div className="footer-column">
            <h4>Company</h4>
            <a href="/about">About</a>
            <a href="/blog">Blog</a>
            <a href="/careers">Careers</a>
            <a href="/contact">Contact</a>
          </div>
          <div className="footer-column">
            <h4>Legal</h4>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/security">Security</a>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <p>© 2025 Agent Relay. All rights reserved.</p>
        <div className="social-links">
          <a href="https://github.com/agent-relay" aria-label="GitHub">
            <GitHubIcon />
          </a>
          <a href="https://twitter.com/agentrelay" aria-label="Twitter">
            <TwitterIcon />
          </a>
          <a href="https://discord.gg/agentrelay" aria-label="Discord">
            <DiscordIcon />
          </a>
        </div>
      </div>
    </footer>
  );
}

// Background components
function GridBackground() {
  return (
    <div className="grid-bg">
      <div className="grid-lines" />
      <div className="grid-glow" />
    </div>
  );
}

function GlowOrbs() {
  return (
    <div className="glow-orbs">
      <div className="orb orb-1" />
      <div className="orb orb-2" />
    </div>
  );
}

// Icons
function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function TwitterIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

export default PricingPage;
