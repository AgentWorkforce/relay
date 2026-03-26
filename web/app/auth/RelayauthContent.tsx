'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { FadeIn } from '../../components/FadeIn';
import s from './relayauth.module.css';

type SdkTab = 'typescript' | 'python' | 'curl';

const featureGroups = [
  {
    title: 'JWT Tokens',
    description: 'Issue short-lived access tokens with sponsor chains, workspace context, and edge-verifiable claims.',
  },
  {
    title: 'Scope-Based Access',
    description: 'Grant exact permissions with plane, resource, action, and optional path constraints.',
  },
  {
    title: 'RBAC Policies',
    description: 'Bundle scopes into named roles and layer deny-first policies from org to workspace to agent.',
  },
  {
    title: 'Audit Trails',
    description: 'Track every token use, scope decision, and admin action back to a responsible human.',
  },
  {
    title: 'Token Revocation',
    description: 'Invalidate credentials globally in under a second with edge-aware revocation checks.',
  },
  {
    title: 'Budget Enforcement',
    description: 'Cap spend, rate, and risky actions before an agent runs away with production access.',
  },
];

const toolBadges = [
  'Claude Code',
  'Codex',
  'Gemini',
  'GitHub Copilot',
  'OpenCode',
  'Custom MCP servers',
  'CI workers',
  'Internal tools',
];

const whyCards = [
  {
    title: 'Zero infrastructure',
    description: 'No auth service to stitch together, no token broker to run, no callback validator to babysit.',
  },
  {
    title: 'Instant setup',
    description: 'Create an identity, issue a token, and protect a route in minutes instead of designing an IAM stack.',
  },
  {
    title: 'Framework-agnostic',
    description: 'Use the same token model across Workers, Node, Python services, edge middleware, and MCP tools.',
  },
];

const getStartedSteps = [
  {
    title: 'Create an identity',
    code: `curl -X POST https://api.relayauth.dev/v1/identities \\
  -H "content-type: application/json" \\
  -d '{
    "name": "billing-bot",
    "org_id": "org_acme",
    "workspace_id": "ws_prod",
    "sponsor_id": "user_jane"
  }'`,
  },
  {
    title: 'Issue a token',
    code: `curl -X POST https://api.relayauth.dev/v1/tokens \\
  -H "content-type: application/json" \\
  -d '{
    "identity_id": "agent_8x2k",
    "scopes": ["stripe:orders:read", "relaycast:channel:write:#billing"],
    "ttl": "1h"
  }'`,
  },
  {
    title: 'Verify at the edge',
    code: `curl https://api.relayauth.dev/.well-known/jwks.json

# Then validate locally and enforce:
# stripe:orders:read`,
  },
];

const sdkCode: Record<SdkTab, string> = {
  typescript: `import { RelayAuthClient } from "@agent-relay/auth";

const auth = new RelayAuthClient({
  apiKey: process.env.RELAYAUTH_API_KEY,
});

const identity = await auth.identities.create({
  name: "billing-bot",
  orgId: "org_acme",
  workspaceId: "ws_prod",
  sponsorId: "user_jane",
});

const token = await auth.tokens.issue({
  identityId: identity.id,
  scopes: [
    "stripe:orders:read",
    "relaycast:channel:write:#billing",
  ],
  ttl: "1h",
});

const claims = await auth.tokens.verify(token.accessToken);
await auth.authorize({
  token: token.accessToken,
  scope: "stripe:orders:read",
});`,
  python: `from relayauth import RelayAuthClient

auth = RelayAuthClient(api_key=os.environ["RELAYAUTH_API_KEY"])

identity = auth.identities.create(
    name="billing-bot",
    org_id="org_acme",
    workspace_id="ws_prod",
    sponsor_id="user_jane",
)

token = auth.tokens.issue(
    identity_id=identity["id"],
    scopes=[
        "stripe:orders:read",
        "relaycast:channel:write:#billing",
    ],
    ttl="1h",
)

claims = auth.tokens.verify(token["access_token"])
auth.authorize(
    token=token["access_token"],
    scope="stripe:orders:read",
)`,
  curl: `curl -X POST https://api.relayauth.dev/v1/identities \\
  -H "authorization: Bearer $RELAYAUTH_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "name": "billing-bot",
    "org_id": "org_acme",
    "workspace_id": "ws_prod",
    "sponsor_id": "user_jane"
  }'

curl -X POST https://api.relayauth.dev/v1/tokens \\
  -H "authorization: Bearer $RELAYAUTH_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{
    "identity_id": "agent_8x2k",
    "scopes": ["stripe:orders:read"],
    "ttl": "1h"
  }'

curl https://api.relayauth.dev/.well-known/jwks.json`,
};

function highlight(code: string, tab: SdkTab) {
  const keywords =
    tab === 'python'
      ? /\b(from|import|await)\b/g
      : /\b(import|from|const|await|new)\b/g;
  const types = /\b(RelayAuthClient)\b/g;
  const methods = /\.(\w+)\(/g;

  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const parts: string[] = [];
  let lastIndex = 0;
  const stringMatches = [...escaped.matchAll(/(["'`])(?:(?!\1).)*\1/g)];

  if (stringMatches.length === 0) {
    return highlightNonString(escaped, keywords, types, methods);
  }

  for (const match of stringMatches) {
    const before = escaped.slice(lastIndex, match.index);
    parts.push(highlightNonString(before, keywords, types, methods));
    parts.push(`<span class="${s.codeString}">${match[0]}</span>`);
    lastIndex = match.index! + match[0].length;
  }

  parts.push(highlightNonString(escaped.slice(lastIndex), keywords, types, methods));
  return parts.join('');
}

function highlightNonString(text: string, keywords: RegExp, types: RegExp, methods: RegExp) {
  return text
    .replace(types, `<span class="${s.codeType}">$1</span>`)
    .replace(keywords, `<span class="${s.codeKeyword}">$&</span>`)
    .replace(methods, `.<span class="${s.codeMethod}">$1</span>(`);
}

function RelayauthAnimation() {
  return (
    <div className={s.authVisual}>
      <div className={s.authFrame}>
        <div className={s.authFrameHeader}>
          <div className={s.previewDots}>
            <span style={{ background: '#ff5f57' }} />
            <span style={{ background: '#febc2e' }} />
            <span style={{ background: '#28c840' }} />
          </div>
          <span className={s.authFrameLabel}>relayauth control plane</span>
        </div>

        <div className={s.authFlowGrid}>
          <div className={s.authCard}>
            <div className={s.authCardTop}>
              <span className={s.authCardLabel}>Identity</span>
              <span className={s.authCardHint}>agent_8x2k</span>
            </div>
            <strong className={s.authCardTitle}>billing-bot</strong>
            <span className={s.authCardMeta}>sponsor: jane@acme.com</span>
          </div>

          <div className={s.authConnector}>
            <span className={s.connectorPulse} />
          </div>

          <div className={s.authCard}>
            <div className={s.authCardTop}>
              <span className={s.authCardLabel}>Token</span>
              <span className={s.authAllowed}>active</span>
            </div>
            <strong className={s.authCardTitle}>TTL 1h</strong>
            <span className={s.authCardMeta}>scoped JWT + refresh chain</span>
          </div>

          <div className={s.policyPanel}>
            <div className={s.policyHeader}>
              <span>Policy evaluation</span>
              <span className={s.authAllowed}>allow</span>
            </div>
            <div className={s.policyRow}>
              <code>stripe:orders:read</code>
              <span className={s.authAllowed}>granted</span>
            </div>
            <div className={s.policyRow}>
              <code>stripe:orders:approve</code>
              <span className={s.authDenied}>denied</span>
            </div>
            <div className={s.policyRow}>
              <code>budget.maxCostPerDay</code>
              <span>$5,000</span>
            </div>
          </div>

          <div className={s.auditPanel}>
            <div className={s.auditRow}>
              <span className={s.auditDot} />
              <span>Issued token for billing-bot</span>
            </div>
            <div className={s.auditRow}>
              <span className={s.auditDot} />
              <span>Verified sponsor chain user_jane → agent_8x2k</span>
            </div>
            <div className={s.auditRow}>
              <span className={s.auditDot} />
              <span>Blocked approve scope escalation</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RelayauthContent() {
  const [tab, setTab] = useState<SdkTab>('typescript');

  const highlightedCode = useMemo(() => highlight(sdkCode[tab], tab), [tab]);

  return (
    <div className={s.page}>
      <div className={s.heroSection}>
        <svg
          className={s.heroBgSvg}
          viewBox="0 0 1200 600"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="xMidYMid slice"
        >
          <g stroke="var(--primary)" strokeWidth="0.9" opacity="0.13">
            <path d="M80,120 L220,140 L380,110 L520,145 L680,120" />
            <path d="M150,280 L310,260 L460,290 L620,270 L780,295" />
            <path d="M60,440 L200,420 L360,450 L510,430 L670,455" />
            <path d="M220,140 L310,260" />
            <path d="M380,110 L460,290" />
            <path d="M520,145 L620,270" />
            <path d="M310,260 L360,450" />
            <path d="M460,290 L510,430" />
            <path d="M620,270 L670,455" />
            <path d="M780,295 L900,240 L1020,280" />
            <path d="M680,120 L830,160 L960,130" />
            <path d="M900,240 L960,130" />
            <path d="M830,160 L780,295" />
            <path d="M120,60 L220,140" />
            <path d="M680,120 L740,40" />
            <path d="M60,440 L30,520" />
            <path d="M670,455 L720,540" />
          </g>
          <g fill="var(--primary)" opacity="0.17">
            <circle cx="80" cy="120" r="3" />
            <circle cx="220" cy="140" r="4" />
            <circle cx="380" cy="110" r="3" />
            <circle cx="520" cy="145" r="4" />
            <circle cx="680" cy="120" r="3" />
            <circle cx="150" cy="280" r="3" />
            <circle cx="310" cy="260" r="4" />
            <circle cx="460" cy="290" r="3" />
            <circle cx="620" cy="270" r="4" />
            <circle cx="780" cy="295" r="3" />
            <circle cx="60" cy="440" r="3" />
            <circle cx="200" cy="420" r="4" />
            <circle cx="360" cy="450" r="3" />
            <circle cx="510" cy="430" r="4" />
            <circle cx="670" cy="455" r="3" />
            <circle cx="830" cy="160" r="3" />
            <circle cx="900" cy="240" r="3" />
            <circle cx="960" cy="130" r="3" />
            <circle cx="1020" cy="280" r="3" />
          </g>
          <g stroke="var(--primary)" strokeWidth="0.75" fill="none" opacity="0.08">
            <rect x="190" y="120" width="60" height="38" rx="6" />
            <rect x="350" y="90" width="60" height="38" rx="6" />
            <rect x="490" y="125" width="60" height="38" rx="6" />
            <rect x="280" y="240" width="60" height="38" rx="6" />
            <rect x="430" y="270" width="60" height="38" rx="6" />
            <rect x="590" y="250" width="60" height="38" rx="6" />
            <rect x="170" y="400" width="60" height="38" rx="6" />
            <rect x="330" y="430" width="60" height="38" rx="6" />
            <rect x="480" y="410" width="60" height="38" rx="6" />
            <rect x="870" y="220" width="60" height="38" rx="6" />
            <rect x="800" y="140" width="60" height="38" rx="6" />
          </g>
          <g fill="var(--primary)" opacity="0.24">
            <circle cx="220" cy="140" r="2" />
            <circle cx="460" cy="290" r="2" />
            <circle cx="670" cy="455" r="2" />
            <circle cx="900" cy="240" r="2" />
          </g>
          <g fill="none" stroke="var(--secondary-500)" strokeWidth="2" opacity="0.28">
            <path d="M210 114 l10 -10 l10 10 v16 h-20 z" />
            <rect x="451" y="274" width="18" height="18" rx="4" />
            <path d="M614 265 a9 9 0 0 1 18 0 v6 h-18 z" />
            <path d="M660 440 l10 -10 l10 10 v16 h-20 z" />
          </g>
        </svg>

        <section className={s.hero}>
          <div className={s.heroLeft}>
            <div className={s.badge}>
              <span className={s.badgeDot} />
              RELAYAUTH
            </div>

            <h1 className={s.headline}>
              Auth &amp; identity
              <br />
              for agents
            </h1>

            <p className={s.subtitle}>
              Tokens, scopes, RBAC, policies, and audit trails for multi-agent systems.
              Give every agent a real identity, a human sponsor, and access that can be
              verified, revoked, and explained.
            </p>

            <div className={s.ctas}>
              <Link href="/docs" className={s.ctaPrimary}>
                Read the Docs
              </Link>
              <a
                href="https://github.com/agentworkforce/relayauth"
                target="_blank"
                rel="noopener noreferrer"
                className={s.ctaSecondary}
              >
                View on GitHub
              </a>
            </div>
          </div>

          <div className={s.heroRight}>
            <RelayauthAnimation />
          </div>
        </section>
      </div>

      <div className={s.featuresWrapper}>
        <div className={s.featuresHeader}>
          <h2 className={s.featuresTitle}>Everything an agent identity layer needs</h2>
          <p className={s.featuresSubtitle}>
            Start with issuance and verification. Scale to budgets, policies, audit, and global revocation.
          </p>
        </div>

        <section className={s.featuresSection}>
          {featureGroups.map((feature, index) => (
            <FadeIn
              key={feature.title}
              direction="up"
              delay={index * 50}
              className={s.featureCard}
            >
              <div className={s.featureCardAccent} />
              <h3 className={s.featureTitle}>{feature.title}</h3>
              <p className={s.featureDesc}>{feature.description}</p>
            </FadeIn>
          ))}
        </section>
      </div>

      <div className={s.toolsWrapper}>
        <section className={s.toolsSection}>
          <FadeIn direction="up" className={s.toolsText}>
            <h2 className={s.sectionTitle}>Works with every AI tool</h2>
            <p className={s.sectionSubtitle}>
              Use the same identity plane across local coding agents, cloud workers, approval bots, and internal platforms.
            </p>
          </FadeIn>
          <FadeIn direction="up" delay={100} className={s.toolBadgeGrid}>
            {toolBadges.map((tool) => (
              <span key={tool} className={s.toolBadge}>
                {tool}
              </span>
            ))}
          </FadeIn>
        </section>
      </div>

      <div className={s.sdkWrapper}>
        <section className={s.sdkSection}>
          <FadeIn direction="right" className={s.sdkText}>
            <h2 className={s.sectionTitle}>Same auth flow, any SDK</h2>
            <p className={s.sectionSubtitle}>
              Create identities, issue scoped tokens, verify claims, and enforce permissions from the same control plane.
            </p>
          </FadeIn>

          <FadeIn direction="left" delay={120} className={s.sdkCodeWrap}>
            <div className={s.codeBlock}>
              <div className={s.tabs}>
                <button
                  type="button"
                  className={`${s.tab} ${tab === 'typescript' ? s.tabActive : ''}`}
                  onClick={() => setTab('typescript')}
                >
                  TypeScript
                </button>
                <button
                  type="button"
                  className={`${s.tab} ${tab === 'python' ? s.tabActive : ''}`}
                  onClick={() => setTab('python')}
                >
                  Python
                </button>
                <button
                  type="button"
                  className={`${s.tab} ${tab === 'curl' ? s.tabActive : ''}`}
                  onClick={() => setTab('curl')}
                >
                  cURL
                </button>
              </div>
              <pre className={s.pre}>
                <code dangerouslySetInnerHTML={{ __html: highlightedCode }} />
              </pre>
            </div>
          </FadeIn>
        </section>
      </div>

      <div className={s.whyWrapper}>
        <section className={s.whySection}>
          <FadeIn direction="up">
            <h2 className={s.sectionTitle}>Why Relayauth</h2>
            <p className={s.sectionSubtitle}>
              Ship authorization for agents without building an identity platform from scratch.
            </p>
          </FadeIn>

          <div className={s.whyCards}>
            {whyCards.map((card, index) => (
              <FadeIn key={card.title} direction="up" delay={index * 100} className={s.whyCard}>
                <h3 className={s.whyCardTitle}>{card.title}</h3>
                <p className={s.whyCardText}>{card.description}</p>
              </FadeIn>
            ))}
          </div>
        </section>
      </div>

      <div className={s.getStartedWrapper}>
        <section className={s.getStartedSection}>
          <FadeIn direction="up">
            <h2 className={s.sectionTitle}>Get started in three requests</h2>
            <p className={s.sectionSubtitle}>
              Create the agent, mint the token, and publish verification keys for every service that needs to trust it.
            </p>
          </FadeIn>

          <div className={s.stepsGrid}>
            {getStartedSteps.map((step, index) => (
              <FadeIn key={step.title} direction="up" delay={index * 120} className={s.stepCard}>
                <div className={s.stepNumber}>{index + 1}</div>
                <h3 className={s.stepTitle}>{step.title}</h3>
                <pre className={s.stepCode}>
                  <code>{step.code}</code>
                </pre>
              </FadeIn>
            ))}
          </div>
        </section>
      </div>

      <div className={s.poweredWrapper}>
        <section className={s.poweredSection}>
          <p className={s.poweredLabel}>Powered by Agent Relay</p>
          <p className={s.poweredCopy}>
            One identity layer for Relaycast, files, cloud jobs, MCP servers, and the rest of your agent stack.
          </p>
        </section>
      </div>
    </div>
  );
}
