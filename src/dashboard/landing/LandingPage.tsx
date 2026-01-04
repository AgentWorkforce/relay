/**
 * Agent Relay Cloud - Landing Page
 *
 * A mission-control themed landing page showcasing AI agent orchestration.
 * Features animated agent networks, live demo, and immersive visuals.
 */

import React, { useState, useEffect, useRef } from 'react';
import './styles.css';
import { Logo, LogoIcon, LogoHero } from '../react-components/Logo';

// Agent providers with their signature colors
const PROVIDERS = {
  claude: { name: 'Claude', color: '#D97757', icon: '◈' },
  codex: { name: 'Codex', color: '#10A37F', icon: '⬡' },
  gemini: { name: 'Gemini', color: '#4285F4', icon: '◇' },
  opencode: { name: 'OpenCode', color: '#00D4AA', icon: '◆' },
  droid: { name: 'Droid', color: '#6366F1', icon: '⬢' },
};

// Simulated agent messages for the live demo
const DEMO_MESSAGES = [
  { from: 'Architect', to: 'all', content: 'Starting auth module implementation. @Backend handle API, @Frontend build login UI.', provider: 'claude' },
  { from: 'Backend', to: 'Architect', content: 'Acknowledged. Setting up JWT middleware and user routes.', provider: 'codex' },
  { from: 'Frontend', to: 'Architect', content: 'On it. Creating login form with OAuth integration.', provider: 'claude' },
  { from: 'Backend', to: 'Frontend', content: 'API ready at /api/auth. Endpoints: POST /login, POST /register, GET /me', provider: 'codex' },
  { from: 'Frontend', to: 'Backend', content: 'Perfect. Integrating now. Need CORS headers for localhost:3000', provider: 'claude' },
  { from: 'Backend', to: 'Frontend', content: 'Done. CORS configured for development.', provider: 'codex' },
  { from: 'Reviewer', to: 'all', content: 'Running security audit on auth implementation...', provider: 'gemini' },
  { from: 'Reviewer', to: 'Backend', content: 'Found issue: password not being hashed. Use bcrypt.', provider: 'gemini' },
  { from: 'Backend', to: 'Reviewer', content: 'Good catch. Fixed and pushed. Using bcrypt with 12 rounds.', provider: 'codex' },
  { from: 'Architect', to: 'all', content: 'Auth module complete. Moving to dashboard implementation.', provider: 'claude' },
];

export function LandingPage() {
  return (
    <div className="landing-page">
      <div className="landing-bg">
        <GridBackground />
        <GlowOrbs />
      </div>

      <Navigation />

      <main>
        <HeroSection />
        <LiveDemoSection />
        <FeaturesSection />
        <ProvidersSection />
        <PricingSection />
        <CTASection />
      </main>

      <Footer />
    </div>
  );
}

function Navigation() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 768) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Prevent body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  const handleNavClick = () => {
    setMobileMenuOpen(false);
  };

  return (
    <nav className={`nav ${scrolled ? 'scrolled' : ''} ${mobileMenuOpen ? 'menu-open' : ''}`}>
      <div className="nav-inner">
        <a href="/" className="nav-logo">
          <LogoIcon size={28} withGlow={true} />
          <span className="logo-text">Agent Relay</span>
        </a>

        <div className="nav-links">
          <a href="#demo">Demo</a>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="/docs" className="nav-docs">Docs</a>
        </div>

        <div className="nav-actions">
          <a href="/login" className="btn-ghost">Sign In</a>
          <a href="/signup" className="btn-primary">Get Started</a>
        </div>

        <button
          className="mobile-menu-toggle"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
        >
          <span className={`hamburger ${mobileMenuOpen ? 'open' : ''}`}>
            <span className="hamburger-line" />
            <span className="hamburger-line" />
            <span className="hamburger-line" />
          </span>
        </button>
      </div>

      {/* Mobile Menu Overlay */}
      <div className={`mobile-menu-overlay ${mobileMenuOpen ? 'open' : ''}`} onClick={handleNavClick} />

      {/* Mobile Menu */}
      <div className={`mobile-menu ${mobileMenuOpen ? 'open' : ''}`}>
        <div className="mobile-menu-content">
          <div className="mobile-nav-links">
            <a href="#demo" onClick={handleNavClick}>Demo</a>
            <a href="#features" onClick={handleNavClick}>Features</a>
            <a href="#pricing" onClick={handleNavClick}>Pricing</a>
            <a href="/docs" onClick={handleNavClick}>Documentation</a>
          </div>
          <div className="mobile-nav-actions">
            <a href="/login" className="btn-ghost btn-full" onClick={handleNavClick}>Sign In</a>
            <a href="/signup" className="btn-primary btn-full" onClick={handleNavClick}>Get Started</a>
          </div>
        </div>
      </div>
    </nav>
  );
}

function HeroSection() {
  return (
    <section className="hero">
      <div className="hero-content">
        <div className="hero-badge">
          <span className="badge-dot" />
          <span>Now in Public Beta</span>
        </div>

        <h1 className="hero-title">
          <span className="title-line">Orchestrate AI Agents</span>
          <span className="title-line gradient">Like a Symphony</span>
        </h1>

        <p className="hero-subtitle">
          Deploy Claude, Codex, and Gemini agents that communicate in real-time.
          One dashboard to rule them all. Zero infrastructure headaches.
        </p>

        <div className="hero-cta">
          <a href="/signup" className="btn-primary btn-large">
            <span>Start Building</span>
            <span className="btn-arrow">→</span>
          </a>
          <a href="#demo" className="btn-ghost btn-large">
            <span className="play-icon">▶</span>
            <span>Watch Demo</span>
          </a>
        </div>

        <div className="hero-stats">
          <div className="stat">
            <span className="stat-value">10K+</span>
            <span className="stat-label">Agents Spawned</span>
          </div>
          <div className="stat-divider" />
          <div className="stat">
            <span className="stat-value">500+</span>
            <span className="stat-label">Teams</span>
          </div>
          <div className="stat-divider" />
          <div className="stat">
            <span className="stat-value">99.9%</span>
            <span className="stat-label">Uptime</span>
          </div>
        </div>
      </div>

      <div className="hero-visual">
        <AgentNetwork />
      </div>
    </section>
  );
}

function AgentNetwork() {
  const agents = [
    { id: 'lead', name: 'Lead', x: 50, y: 30, provider: 'claude', pulse: true },
    { id: 'backend', name: 'Backend', x: 25, y: 55, provider: 'codex', pulse: false },
    { id: 'frontend', name: 'Frontend', x: 75, y: 55, provider: 'claude', pulse: false },
    { id: 'reviewer', name: 'Reviewer', x: 50, y: 80, provider: 'gemini', pulse: false },
  ];

  const connections = [
    { from: 'lead', to: 'backend' },
    { from: 'lead', to: 'frontend' },
    { from: 'backend', to: 'frontend' },
    { from: 'backend', to: 'reviewer' },
    { from: 'frontend', to: 'reviewer' },
  ];

  return (
    <div className="agent-network">
      <svg className="network-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        {connections.map((conn, i) => {
          const fromAgent = agents.find((a) => a.id === conn.from)!;
          const toAgent = agents.find((a) => a.id === conn.to)!;
          return (
            <g key={i}>
              <line
                x1={fromAgent.x}
                y1={fromAgent.y}
                x2={toAgent.x}
                y2={toAgent.y}
                className="network-line"
              />
              <line
                x1={fromAgent.x}
                y1={fromAgent.y}
                x2={toAgent.x}
                y2={toAgent.y}
                className="network-line-glow"
                style={{ animationDelay: `${i * 0.3}s` }}
              />
            </g>
          );
        })}
      </svg>

      {agents.map((agent) => {
        const provider = PROVIDERS[agent.provider as keyof typeof PROVIDERS];
        return (
          <div
            key={agent.id}
            className={`network-agent ${agent.pulse ? 'pulse' : ''}`}
            style={{
              left: `${agent.x}%`,
              top: `${agent.y}%`,
              '--agent-color': provider.color,
            } as React.CSSProperties}
          >
            <div className="agent-glow" />
            <div className="agent-icon">{provider.icon}</div>
            <div className="agent-label">{agent.name}</div>
          </div>
        );
      })}

      <DataPacket fromX={50} fromY={30} toX={25} toY={55} delay={0} />
      <DataPacket fromX={25} fromY={55} toX={75} toY={55} delay={1} />
      <DataPacket fromX={75} fromY={55} toX={50} toY={80} delay={2} />
    </div>
  );
}

function DataPacket({ fromX, fromY, toX, toY, delay }: { fromX: number; fromY: number; toX: number; toY: number; delay: number }) {
  return (
    <div
      className="data-packet"
      style={{
        '--from-x': `${fromX}%`,
        '--from-y': `${fromY}%`,
        '--to-x': `${toX}%`,
        '--to-y': `${toY}%`,
        animationDelay: `${delay}s`,
      } as React.CSSProperties}
    />
  );
}

function LiveDemoSection() {
  const [messages, setMessages] = useState<typeof DEMO_MESSAGES>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentIndex >= DEMO_MESSAGES.length) {
      // Reset after a pause
      const timeout = setTimeout(() => {
        setMessages([]);
        setCurrentIndex(0);
      }, 3000);
      return () => clearTimeout(timeout);
    }

    const timeout = setTimeout(() => {
      setMessages((prev) => [...prev, DEMO_MESSAGES[currentIndex]]);
      setCurrentIndex((prev) => prev + 1);
    }, 1500);

    return () => clearTimeout(timeout);
  }, [currentIndex]);

  useEffect(() => {
    // Scroll within the container only, not the page
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  return (
    <section id="demo" className="demo-section">
      <div className="section-header">
        <span className="section-tag">Live Demo</span>
        <h2>Watch Agents Collaborate</h2>
        <p>See how multiple AI agents work together on a real task in real-time.</p>
      </div>

      <div className="demo-container">
        <div className="demo-window">
          <div className="window-header">
            <div className="window-dots">
              <span className="dot red" />
              <span className="dot yellow" />
              <span className="dot green" />
            </div>
            <div className="window-title">Agent Relay — auth-module</div>
            <div className="window-status">
              <span className="status-dot" />
              <span>4 agents online</span>
            </div>
          </div>

          <div className="demo-content">
            <div className="demo-sidebar">
              <div className="sidebar-section">
                <div className="sidebar-label">AGENTS</div>
                {['Architect', 'Backend', 'Frontend', 'Reviewer'].map((name, i) => {
                  const providers = ['claude', 'codex', 'claude', 'gemini'];
                  const provider = PROVIDERS[providers[i] as keyof typeof PROVIDERS];
                  return (
                    <div key={name} className="sidebar-agent">
                      <span className="agent-dot" style={{ background: provider.color }} />
                      <span className="agent-name">{name}</span>
                      <span className="agent-status">●</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="demo-messages" ref={messagesContainerRef}>
              {messages.map((msg, i) => {
                const provider = PROVIDERS[msg.provider as keyof typeof PROVIDERS];
                return (
                  <div key={i} className="message" style={{ '--msg-color': provider.color } as React.CSSProperties}>
                    <div className="message-header">
                      <span className="message-icon" style={{ background: provider.color }}>{provider.icon}</span>
                      <span className="message-from">{msg.from}</span>
                      <span className="message-arrow">→</span>
                      <span className="message-to">{msg.to === 'all' ? 'everyone' : msg.to}</span>
                      <span className="message-time">just now</span>
                    </div>
                    <div className="message-content">{msg.content}</div>
                  </div>
                );
              })}

              {messages.length < DEMO_MESSAGES.length && (
                <div className="typing-indicator">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="demo-caption">
          <p>This is a simulation of agents completing a task. In production, agents run your actual code.</p>
        </div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const features = [
    {
      icon: '⚡',
      title: 'One-Click Workspaces',
      description: 'Spin up isolated environments for each project. Connect your repo and agents are ready in seconds.',
    },
    {
      icon: '🔄',
      title: 'Real-Time Messaging',
      description: 'Agents communicate through a blazing-fast relay. @mentions, broadcasts, and direct messages.',
    },
    {
      icon: '🔐',
      title: 'Secure Credential Vault',
      description: 'Store API keys and secrets encrypted at rest. Agents access only what they need.',
    },
    {
      icon: '🎯',
      title: 'Smart Orchestration',
      description: 'Lead agents delegate tasks. Workers report progress. The system handles the complexity.',
    },
    {
      icon: '📊',
      title: 'Full Observability',
      description: 'Trace every message, tool call, and decision. Replay and debug any session.',
    },
    {
      icon: '🚀',
      title: 'Auto-Scaling',
      description: 'From 1 agent to 100. Pay only for what you use. Scale down to zero when idle.',
    },
  ];

  return (
    <section id="features" className="features-section">
      <div className="section-header">
        <span className="section-tag">Features</span>
        <h2>Everything You Need</h2>
        <p>Built for developers who want AI agents that actually work together.</p>
      </div>

      <div className="features-grid">
        {features.map((feature, i) => (
          <div key={i} className="feature-card" style={{ animationDelay: `${i * 0.1}s` }}>
            <div className="feature-icon">{feature.icon}</div>
            <h3>{feature.title}</h3>
            <p>{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProvidersSection() {
  return (
    <section className="providers-section">
      <div className="section-header">
        <span className="section-tag">Providers</span>
        <h2>Bring Your Own Agents</h2>
        <p>Use any AI provider. Mix and match for the perfect team.</p>
      </div>

      <div className="providers-grid">
        {Object.entries(PROVIDERS).map(([key, provider]) => (
          <div key={key} className="provider-card" style={{ '--provider-color': provider.color } as React.CSSProperties}>
            <div className="provider-icon">{provider.icon}</div>
            <div className="provider-name">{provider.name}</div>
            <div className="provider-status">Supported</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PricingSection() {
  const plans = [
    {
      name: 'Free',
      price: '$0',
      period: 'forever',
      description: 'Try it out on a side project',
      features: ['1 workspace', '3 repositories', '2 concurrent agents', '10 compute hours/month', 'Community support'],
      cta: 'Get Started',
      highlighted: false,
    },
    {
      name: 'Pro',
      price: '$29',
      period: '/month',
      description: 'For professional developers',
      features: ['5 workspaces', '20 repositories', '10 concurrent agents', '100 compute hours/month', 'Coordinator agents', 'Email support'],
      cta: 'Start Free Trial',
      highlighted: true,
    },
    {
      name: 'Team',
      price: '$99',
      period: '/month',
      description: 'For growing teams',
      features: ['20 workspaces', '100 repositories', '50 concurrent agents', '500 compute hours/month', 'Coordinator agents', 'Priority support', 'Audit logs'],
      cta: 'Start Free Trial',
      highlighted: false,
    },
    {
      name: 'Enterprise',
      price: 'Custom',
      period: '',
      description: 'For organizations at scale',
      features: ['Unlimited workspaces', 'Unlimited repositories', 'Unlimited agents', 'Unlimited compute', 'SSO/SAML', 'SLA guarantee', 'Dedicated support'],
      cta: 'Contact Sales',
      highlighted: false,
    },
  ];

  return (
    <section id="pricing" className="pricing-section">
      <div className="section-header">
        <span className="section-tag">Pricing</span>
        <h2>Simple, Transparent Pricing</h2>
        <p>Start free. Scale as you grow. No hidden fees.</p>
      </div>

      <div className="pricing-grid">
        {plans.map((plan, i) => (
          <div key={i} className={`pricing-card ${plan.highlighted ? 'highlighted' : ''}`}>
            {plan.highlighted && <div className="popular-badge">Most Popular</div>}
            <div className="pricing-header">
              <h3>{plan.name}</h3>
              <div className="pricing-price">
                <span className="price">{plan.price}</span>
                <span className="period">{plan.period}</span>
              </div>
              <p className="pricing-description">{plan.description}</p>
            </div>
            <ul className="pricing-features">
              {plan.features.map((feature, j) => (
                <li key={j}>
                  <span className="check">✓</span>
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            <a href="/signup" className={`btn-${plan.highlighted ? 'primary' : 'ghost'} btn-full`}>
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section className="cta-section">
      <div className="cta-content">
        <h2>Ready to Orchestrate?</h2>
        <p>Join thousands of developers building with AI agent teams.</p>
        <div className="cta-buttons">
          <a href="/signup" className="btn-primary btn-large">
            <span>Start Building Free</span>
            <span className="btn-arrow">→</span>
          </a>
          <a href="/docs" className="btn-ghost btn-large">Read the Docs</a>
        </div>
      </div>

      <div className="cta-terminal">
        <div className="terminal-header">
          <span className="terminal-prompt">$</span>
          <span className="terminal-text">npx agent-relay init</span>
        </div>
        <div className="terminal-output">
          <span className="output-line">✓ Connected to Agent Relay Cloud</span>
          <span className="output-line">✓ Workspace created: my-project</span>
          <span className="output-line">✓ Ready to spawn agents</span>
          <span className="output-line cursor">→ agent-relay spawn Lead --provider claude</span>
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
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
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
        <p>© 2026 Agent Relay. All rights reserved.</p>
        <div className="social-links">
          <a href="https://github.com/AgentWorkforce/relay" aria-label="GitHub">
            <GitHubIcon />
          </a>
          <a href="https://twitter.com/agent_relay" aria-label="Twitter">
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
      <div className="orb orb-3" />
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

export default LandingPage;
