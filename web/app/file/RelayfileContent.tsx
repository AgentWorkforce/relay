'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { FadeIn } from '../../components/FadeIn';

import s from './relayfile.module.css';

const featureCards = [
  {
    title: 'Provider files',
    desc: 'Mount Linear issues, GitHub PRs, Notion pages, Slack channels, and SaaS records as ordinary paths.',
  },
  {
    title: 'File writeback',
    desc: 'Create, patch, and delete provider records by saving files. Adapters validate changes and queue writeback.',
  },
  {
    title: 'Realtime sync',
    desc: 'Every writer publishes a new revision so other agents see fresh state on their next read.',
  },
  {
    title: 'Scoped mounts',
    desc: 'Give each agent path-level read, write, watch, or admin permissions instead of broad provider credentials.',
  },
  {
    title: 'Deterministic digests',
    desc: 'Precompute high-value rollups like yesterday.md so agents start with the answer-shaped file.',
  },
  {
    title: 'Native tools',
    desc: 'Agents use cat, grep, find, jq, rg, and editors against a real local mount or the HTTP API.',
  },
];

const integrationBadges = [
  'Linear',
  'GitHub',
  'Notion',
  'Slack',
  'HubSpot',
  'Salesforce',
  'Google Drive',
  'Gmail',
  'Composio',
  'Pipedream',
  'Nango',
  'Custom APIs',
];

const sdkTabs = {
  mount: {
    label: 'Mount SDK',
    language: 'typescript',
    code: `import { RelayfileSetup } from '@relayfile/sdk';

const setup = new RelayfileSetup({
  accessToken: process.env.RELAYFILE_ACCESS_TOKEN!,
});

const handle = await setup.ensureMountedWorkspace({
  workspaceId: 'rw_123',
  provider: 'notion',
  verifyProvider: true,
  localDir: '/workspace/relayfile',
});

console.log(handle.env().RELAYFILE_LOCAL_DIR);`,
    bullets: [
      'Attach a hosted workspace inside Daytona, E2B, CI, or your own sandbox.',
      'Gate startup on provider readiness before the agent begins work.',
      'The agent receives a normal directory plus environment variables.',
    ],
  },
  vercel: {
    label: 'Vercel AI SDK',
    language: 'typescript',
    code: `import { generateText, tool } from 'ai';
import { z } from 'zod';
import { RelayFileClient } from '@relayfile/sdk';

const files = new RelayFileClient({ token: process.env.RELAYFILE_TOKEN! });

const { text } = await generateText({
  model: process.env.AI_MODEL!,
  prompt: 'What changed yesterday across GitHub, Linear, and Notion?',
  tools: {
    readRelayfile: tool({
      description: 'Read a file from the Relayfile workspace',
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }) => files.readFile('rw_123', path),
    }),
  },
});`,
    bullets: [
      'Expose one Relayfile read tool instead of one tool per provider.',
      'Let the model inspect digests first, then open raw provider files as needed.',
      'Works with generateText, streamText, and AI Gateway model strings.',
    ],
  },
  anthropic: {
    label: 'Claude Agent SDK',
    language: 'typescript',
    code: `import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { RelayFileClient } from '@relayfile/sdk';

const files = new RelayFileClient({ token: process.env.RELAYFILE_TOKEN! });

const relayfileServer = createSdkMcpServer({
  name: 'relayfile',
  tools: [
    tool('readRelayfile', 'Read workspace files', { path: z.string() }, async ({ path }) => ({
      content: [{ type: 'text', text: JSON.stringify(await files.readFile('rw_123', path)) }],
    })),
  ],
});

for await (const message of query({
  prompt: 'Summarize yesterday.md, then draft Linear follow-ups.',
  options: { mcpServers: { relayfile: relayfileServer } },
})) {
  console.log(message);
}`,
    bullets: [
      'Keep Claude in its normal agent loop while Relayfile owns provider context.',
      'Use path-scoped tokens for the files the Claude worker may read or write.',
      'Pair with a mounted directory when the agent should use bash directly.',
    ],
  },
  openai: {
    label: 'OpenAI Agents',
    language: 'typescript',
    code: `import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { RelayFileClient } from '@relayfile/sdk';

const files = new RelayFileClient({ token: process.env.RELAYFILE_TOKEN! });

const agent = new Agent({
  name: 'workspace-reviewer',
  instructions: 'Use Relayfile paths before asking for provider-specific tools.',
  tools: [
    tool({
      name: 'read_relayfile',
      parameters: z.object({ path: z.string() }),
      execute: ({ path }) => files.readFile('rw_123', path),
    }),
  ],
});

await run(agent, 'Review /digests/yesterday.md and file Linear follow-ups.');`,
    bullets: [
      'Use Relayfile as the agent state and integration layer for SDK-owned runs.',
      'Keep orchestration, approvals, and tracing in the framework you already use.',
      'Add write tools only for scoped paths that the agent is allowed to change.',
    ],
  },
  curl: {
    label: 'cURL',
    language: 'curl',
    code: `curl "https://api.agentrelay.com/relayfile/v1/workspaces/rw_123/fs/tree?path=/" \\
  -H "authorization: Bearer $RELAYFILE_TOKEN"

curl "https://api.agentrelay.com/relayfile/v1/workspaces/rw_123/fs/file?path=/digests/yesterday.md" \\
  -H "authorization: Bearer $RELAYFILE_TOKEN"

curl -X PUT "https://api.agentrelay.com/relayfile/v1/workspaces/rw_123/fs/file?path=/linear/issues/AGE-12.json" \\
  -H "authorization: Bearer $RELAYFILE_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"contentType":"application/json","content":"{\\"state\\":\\"In Review\\"}"}'`,
    bullets: [
      'Debug the exact HTTP surface behind the SDK and mount daemon.',
      'Use standard shell tools in CI or one-off operational scripts.',
      'Query the tree, read files, and submit provider writeback from one API.',
    ],
  },
} as const;

const whyCards = [
  {
    title: 'No schema tax',
    desc: 'Agents open the files they need instead of loading a large typed tool surface for every connected provider.',
  },
  {
    title: 'Useful writes',
    desc: 'Provider updates are file operations with validation, retries, and audit trails handled by the integration layer.',
  },
  {
    title: 'Multi-agent by default',
    desc: 'Reviewer, implementer, and orchestrator agents can all mount the same workspace and react to the same revisions.',
  },
];

const steps = [
  {
    step: '01',
    title: 'Connect a provider',
    code: `npx relayfile setup \\
  --provider notion \\
  --workspace research-room \\
  --local-dir ./relayfile-mount`,
  },
  {
    step: '02',
    title: 'Read the tree',
    code: `ls ./relayfile-mount
cat ./relayfile-mount/LAYOUT.md
cat ./relayfile-mount/digests/yesterday.md`,
  },
  {
    step: '03',
    title: 'Write back',
    code: `cat > ./relayfile-mount/linear/issues/drafts/follow-up.json <<'JSON'
{
  "title": "Follow up from digest",
  "state": "Todo"
}
JSON`,
  },
];

type Lang = 'typescript' | 'python' | 'curl';

function highlightNonString(text: string, keywords: RegExp, types: RegExp, methods: RegExp) {
  return text
    .replace(types, `<span class="${s.codeType}">$1</span>`)
    .replace(keywords, `<span class="${s.codeKeyword}">$&</span>`)
    .replace(methods, `.<span class="${s.codeMethod}">$1</span>(`);
}

function highlight(code: string, lang: Lang) {
  const keywords =
    lang === 'python'
      ? /\b(from|import|await|for|in)\b/g
      : lang === 'curl'
        ? /\b(curl)\b/g
        : /\b(import|from|const|await|new)\b/g;
  const types = /\b(RelayfileSetup|RelayFileClient|Agent|Relayfile)\b/g;
  const methods = /\.(\w+)\(/g;

  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

function RelayfileAnimation() {
  return (
    <div className={s.animationShell}>
      <div className={s.animationAura} />
      <div className={s.animationBoard}>
        <div className={s.boardHeader}>
          <div className={s.previewDots}>
            <span style={{ background: '#ff5f57' }} />
            <span style={{ background: '#febc2e' }} />
            <span style={{ background: '#28c840' }} />
          </div>
          <span className={s.boardTitle}>relayfile workspace</span>
        </div>

        <div className={s.boardCanvas}>
          <div className={`${s.folderCard} ${s.folderCardMain}`}>
            <span className={s.folderLabel}>workspace</span>
            <span className={s.folderMeta}>shared volume</span>
          </div>
          <div className={`${s.folderCard} ${s.folderCardTop}`}>
            <span className={s.folderLabel}>/plans</span>
            <span className={s.folderMeta}>watching</span>
          </div>
          <div className={`${s.fileCard} ${s.fileCardLeft}`}>
            <span className={s.fileName}>brief.md</span>
            <span className={s.fileMeta}>updated 2s ago</span>
          </div>
          <div className={`${s.fileCard} ${s.fileCardRight}`}>
            <span className={s.fileName}>tasks.json</span>
            <span className={s.fileMeta}>locked by Builder</span>
          </div>
          <div className={`${s.fileCard} ${s.fileCardBottom}`}>
            <span className={s.fileName}>deploy.log</span>
            <span className={s.fileMeta}>streaming</span>
          </div>

          <svg className={s.boardLinks} viewBox="0 0 640 420" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M312 118C276 150 244 186 194 210" />
            <path d="M328 122C382 164 414 182 468 208" />
            <path d="M320 142C320 220 320 238 320 286" />
            <path d="M264 96C246 68 214 44 170 34" />
            <path d="M376 96C404 62 456 40 520 34" />
          </svg>

          <div className={`${s.pulse} ${s.pulseOne}`} />
          <div className={`${s.pulse} ${s.pulseTwo}`} />
          <div className={`${s.pulse} ${s.pulseThree}`} />

          <div className={s.activityRail}>
            <div className={s.activityRow}>
              <span className={s.activityType}>WATCH</span>
              <span className={s.activityPath}>/plans</span>
            </div>
            <div className={s.activityRow}>
              <span className={s.activityType}>WRITE</span>
              <span className={s.activityPath}>/docs/spec.md</span>
            </div>
            <div className={s.activityRow}>
              <span className={s.activityType}>LOCK</span>
              <span className={s.activityPath}>/tasks.json</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RelayfileContent() {
  const [activeTab, setActiveTab] = useState<keyof typeof sdkTabs>('mount');
  const activeSdk = sdkTabs[activeTab];
  const highlightedSdk = useMemo(() => highlight(activeSdk.code, activeSdk.language), [activeSdk]);
  const highlightedSteps = useMemo(() => steps.map((step) => highlight(step.code, 'curl')), []);

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
            <path d="M92,126 L240,144 L390,116 L542,146 L700,122" />
            <path d="M146,286 L308,262 L468,296 L620,272 L790,300" />
            <path d="M74,446 L218,424 L372,450 L526,432 L684,458" />
            <path d="M240,144 L308,262" />
            <path d="M390,116 L468,296" />
            <path d="M542,146 L620,272" />
            <path d="M308,262 L372,450" />
            <path d="M468,296 L526,432" />
            <path d="M620,272 L684,458" />
            <path d="M790,300 L922,244 L1040,286" />
            <path d="M700,122 L848,164 L968,136" />
            <path d="M922,244 L968,136" />
            <path d="M848,164 L790,300" />
          </g>
          <g fill="var(--primary)" opacity="0.15">
            <rect x="58" y="104" width="42" height="28" rx="6" />
            <path d="M214 122h18l8 10h26v24h-52z" />
            <rect x="366" y="98" width="34" height="42" rx="6" />
            <path d="M520 126h22l7 9h28v24h-57z" />
            <rect x="666" y="102" width="38" height="32" rx="6" />
            <rect x="132" y="268" width="34" height="42" rx="6" />
            <path d="M286 244h18l8 10h26v24h-52z" />
            <rect x="444" y="272" width="34" height="42" rx="6" />
            <path d="M598 252h18l8 10h26v24h-52z" />
            <rect x="764" y="278" width="34" height="42" rx="6" />
            <path d="M42 426h18l8 10h26v24H42z" />
            <rect x="202" y="402" width="34" height="42" rx="6" />
            <path d="M344 430h18l8 10h26v24h-52z" />
            <rect x="500" y="410" width="34" height="42" rx="6" />
            <path d="M650 438h18l8 10h26v24h-52z" />
            <rect x="892" y="220" width="34" height="42" rx="6" />
            <path d="M816 144h18l8 10h26v24h-52z" />
          </g>
          <g stroke="var(--primary)" strokeWidth="0.75" fill="none" opacity="0.08">
            <rect x="188" y="118" width="68" height="42" rx="8" />
            <rect x="350" y="92" width="60" height="44" rx="8" />
            <rect x="486" y="124" width="70" height="42" rx="8" />
            <rect x="278" y="240" width="66" height="40" rx="8" />
            <rect x="430" y="268" width="62" height="44" rx="8" />
            <rect x="586" y="248" width="66" height="40" rx="8" />
            <rect x="168" y="396" width="68" height="42" rx="8" />
            <rect x="328" y="426" width="66" height="40" rx="8" />
            <rect x="474" y="406" width="68" height="42" rx="8" />
            <rect x="860" y="214" width="68" height="42" rx="8" />
            <rect x="794" y="136" width="68" height="42" rx="8" />
          </g>
          <g fill="var(--primary)" opacity="0.24">
            <circle cx="240" cy="144" r="2.5" />
            <circle cx="468" cy="296" r="2.5" />
            <circle cx="684" cy="458" r="2.5" />
            <circle cx="922" cy="244" r="2.5" />
          </g>
        </svg>

        <section className={s.hero}>
          <div className={s.heroLeft}>
            <span className={s.badge}>
              <span className={s.badgeDot} />
              INTEGRATION FILESYSTEM FOR AGENTS
            </span>

            <h1 className={s.headline}>
              Relayfile
              <br />
              gives agents files
            </h1>

            <p className={s.subtitle}>
              Mount Linear, GitHub, Notion, Slack, HubSpot, Salesforce, and your own systems as a realtime
              filesystem. Agents inspect provider data with bash, write records by saving files, and
              coordinate through scoped mounts instead of bespoke tool glue.
            </p>

            <div className={s.ctas}>
              <Link href="/docs" className={s.ctaPrimary}>
                Read the Docs
              </Link>
              <a
                href="https://github.com/agentworkforce/relayfile"
                target="_blank"
                rel="noopener noreferrer"
                className={s.ctaSecondary}
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
                View on GitHub
              </a>
            </div>
          </div>

          <div className={s.heroRight}>
            <RelayfileAnimation />
          </div>
        </section>
      </div>

      <div className={s.featuresWrapper}>
        <div className={s.featuresHeader}>
          <h2 className={s.featuresTitle}>The file interface for integration work</h2>
          <p className={s.featuresSubtitle}>
            Relayfile turns the systems where work happens into paths an agent can list, read, grep, edit, and
            watch.
          </p>
        </div>

        <section className={s.featuresSection}>
          {featureCards.map((feature, index) => (
            <FadeIn key={feature.title} direction="up" delay={index * 45} className={s.featureCol}>
              <div className={s.featureTile}>
                <div className={s.featureChip}>{String(index + 1).padStart(2, '0')}</div>
                <h3 className={s.featureTitle}>{feature.title}</h3>
                <p className={s.featureDesc}>{feature.desc}</p>
              </div>
            </FadeIn>
          ))}
        </section>
      </div>

      <div className={s.byohWrapper}>
        <section className={s.byohSection}>
          <FadeIn direction="up" className={s.byohText}>
            <h2 className={s.byohTitle}>Mount the systems agents actually use</h2>
            <p className={s.byohSubtitle}>
              Provider auth, pagination, sync, and writeback stay behind the mount. The agent sees one
              workspace tree with layouts, indexes, digests, and provider records side by side.
            </p>
          </FadeIn>
          <FadeIn direction="up" delay={120} className={s.byohLogos}>
            {integrationBadges.map((integration) => (
              <span key={integration} className={s.toolBadge}>
                {integration}
              </span>
            ))}
          </FadeIn>
        </section>
      </div>

      <div className={s.sdkWrapper}>
        <section className={s.sdkSection}>
          <FadeIn direction="right" className={s.sdkText}>
            <span className={s.openclawBadge}>SDK</span>
            <h2 className={s.sdkTitle}>Use the same files from code, HTTP, or a mount</h2>
            <p className={s.sdkSubtitle}>
              Vercel AI SDK, Claude Agent SDK, OpenAI Agents SDK, scripts, and terminal-native agents can all
              read the same workspace tree and write through the same contract.
            </p>

            <div className={s.tabRow}>
              {(Object.keys(sdkTabs) as Array<keyof typeof sdkTabs>).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`${s.tabButton} ${activeTab === tab ? s.tabButtonActive : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {sdkTabs[tab].label}
                </button>
              ))}
            </div>

            <div className={s.sdkBullets}>
              {activeSdk.bullets.map((bullet) => (
                <div key={bullet} className={s.sdkBullet}>
                  <span className={s.sdkBulletDot} />
                  <span>{bullet}</span>
                </div>
              ))}
            </div>
          </FadeIn>

          <FadeIn direction="left" delay={100} className={s.sdkCode}>
            <div className={s.codePanel}>
              <div className={s.previewTitleBar}>
                <div className={s.previewDots}>
                  <span style={{ background: '#ff5f57' }} />
                  <span style={{ background: '#febc2e' }} />
                  <span style={{ background: '#28c840' }} />
                </div>
                <span className={s.previewTitleText}>{activeSdk.label}</span>
              </div>
              <pre className={s.sdkCodeBlock}>
                <code dangerouslySetInnerHTML={{ __html: highlightedSdk }} />
              </pre>
            </div>
          </FadeIn>
        </section>
      </div>

      <div className={s.deployWrapper}>
        <section className={s.deploySection}>
          <FadeIn direction="up">
            <h2 className={s.deployTitle}>Why Relayfile</h2>
            <p className={s.deploySubtitle}>
              Purpose-built for agents that need to work across real SaaS systems.
            </p>
          </FadeIn>

          <div className={s.deployCards}>
            {whyCards.map((card, index) => (
              <FadeIn key={card.title} direction="up" delay={index * 100}>
                <div className={s.deployCard}>
                  <div className={s.deployIcon}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                  </div>
                  <h3 className={s.deployCardTitle}>{card.title}</h3>
                  <p className={s.deployCardText}>{card.desc}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </section>
      </div>

      <div className={s.openclawWrapper}>
        <section className={s.openclawSection}>
          <FadeIn direction="right" className={s.openclawText}>
            <h2 className={s.openclawTitle}>Get useful in three moves</h2>
            <p className={s.openclawSubtitle}>
              Connect a provider, read the generated workspace, then write back through the same file
              interface. The first useful workflow is a directory listing, not a framework migration.
            </p>
          </FadeIn>

          <div className={s.stepsGrid}>
            {steps.map((step, index) => (
              <FadeIn key={step.step} direction="up" delay={index * 100}>
                <div className={s.stepCard}>
                  <div className={s.stepHeader}>
                    <span className={s.stepNumber}>{step.step}</span>
                    <h3 className={s.stepTitle}>{step.title}</h3>
                  </div>
                  <pre className={s.stepCode}>
                    <code dangerouslySetInnerHTML={{ __html: highlightedSteps[index] }} />
                  </pre>
                </div>
              </FadeIn>
            ))}
          </div>
        </section>
      </div>

      <div className={s.poweredWrapper}>
        <FadeIn direction="up">
          <div className={s.poweredCard}>
            <span className={s.poweredEyebrow}>Powered by Agent Relay</span>
            <p className={s.poweredText}>
              Relayfile extends the Agent Relay platform with shared storage for agents that communicate,
              coordinate, and act on the same files.
            </p>
          </div>
        </FadeIn>
      </div>
    </div>
  );
}
