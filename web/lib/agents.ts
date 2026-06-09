// Catalog of the AgentWorkforce proactive agents surfaced at /agents.
//
// Source of truth for each agent's behavior is its persona in the agents repo
// (AgentWorkforce/agents/<dir>/persona.json), confirmed with the workforce
// catalog. Graphics are synced into public/agents/<slug>/ by
// scripts/sync-agent-assets.sh. Agents without committed art render a brand
// gradient + monogram fallback (see hasCustomArt).

export type Integration =
  | 'github'
  | 'linear'
  | 'slack'
  | 'notion'
  | 'spotify'
  | 'granola'
  | 'hacker-news'
  | 'npm';

export interface Agent {
  /** URL segment under /agents/<slug>. */
  slug: string;
  /** Persona id from persona.json. */
  personaId: string;
  /** Directory / persona path within its repo. */
  dir: string;
  /** GitHub repo that hosts the agent (defaults to the agents monorepo). */
  repo?: string;
  /** Persona definition filename inside dir (defaults to persona.ts). */
  personaFile?: string;
  name: string;
  /** One punchy line for cards and hero. */
  tagline: string;
  /** 2–3 sentence summary of what the agent does. */
  description: string;
  /** Concrete bullets describing the behavior. */
  highlights: string[];
  /** What fires the agent and how often. */
  trigger: AgentTrigger;
  integrations: Integration[];
  /** Harness + model the persona ships with. */
  runtime: string;
  /** Inputs the user configures when deploying (env var names). */
  inputs: string[];
  /** Accent color used for card glow + art fallback. */
  accent: string;
  /** Whether committed banner/card PNGs exist under public/agents/<slug>. */
  hasCustomArt: boolean;
}

export interface AgentTrigger {
  /** Whether the agent runs on a schedule or reacts to an event. */
  kind: 'schedule' | 'event';
  /** Human-readable summary, e.g. "Weekday mornings · 8am ET". */
  summary: string;
  /** Technical detail (cron expression or event names) shown as a code chip. */
  detail: string;
}

export const INTEGRATION_LABELS: Record<Integration, string> = {
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  notion: 'Notion',
  spotify: 'Spotify',
  granola: 'Granola',
  'hacker-news': 'Hacker News',
  npm: 'npm',
};

export const AGENTS: Agent[] = [
  {
    slug: 'review',
    personaId: 'pr-reviewer',
    dir: 'review',
    name: 'PR Reviewer',
    tagline: 'Reviews, fixes, and shepherds pull requests — then merges once you approve.',
    description:
      'A rigorous senior reviewer that runs a full review loop over every pull request. It fixes the issues it finds, clears other bots’ comments, resolves failing CI and merge conflicts where it can, pings Slack the moment the PR is genuinely ready, and merges once an authorized approval lands.',
    highlights: [
      'Reviews opened and updated PRs and pushes fixes to the branch.',
      'Resolves failing CI and merge conflicts before handing back.',
      'Notifies Slack — threaded per PR, deduped per head commit — when ready.',
      'Merges automatically once an approver in APPROVERS approves.',
    ],
    trigger: {
      kind: 'event',
      summary: 'When a PR is opened or updated',
      detail: 'pull_request · review comments · check runs · review submitted',
    },
    integrations: ['github', 'slack'],
    runtime: 'Codex · gpt-5.5',
    inputs: ['SLACK_CHANNEL', 'APPROVERS', 'REVIEW_AUTHORS', 'SKIP_LABELS'],
    accent: '#2d6a9c',
    hasCustomArt: true,
  },
  {
    slug: 'repo-hygiene',
    personaId: 'repo-hygiene',
    dir: 'repo-hygiene',
    name: 'Repo Hygiene',
    tagline: 'Finds codebase entropy before it turns into maintenance debt.',
    description:
      'A read-only hygiene reviewer that diagnoses every opened and updated PR for duplicated or dead code, divergent implementation paths, stale skills/rules/docs, and concrete code smells. It comments concise findings on GitHub, journals each run to Notion, and recalls prior runs from memory to track divergence over time.',
    highlights: [
      'Flags duplicated/dead code and divergent implementation paths.',
      'Surfaces stale skills, rules, docs, and code smells.',
      'Journals every run to a Notion database for an audit trail.',
      'Uses workspace memory to catch recurring maintainability issues.',
    ],
    trigger: {
      kind: 'event',
      summary: 'When a PR is opened or updated',
      detail: 'pull_request.opened · pull_request.synchronize',
    },
    integrations: ['github', 'notion', 'slack'],
    runtime: 'Codex · gpt-5.5',
    inputs: ['NOTION_DATABASE_ID', 'SLACK_CHANNEL', 'MAX_DIFF_CHARS'],
    accent: '#26557e',
    hasCustomArt: true,
  },
  {
    slug: 'granola',
    personaId: 'granola-prospect',
    dir: 'granola',
    name: 'Granola Prospect',
    tagline: 'Converts prospect calls into issues and implementation PRs.',
    description:
      'Listens for new Granola meeting notes, reads the transcript, and decides whether the call contained a prospect feature ask. When it finds one, it files a Linear issue capturing the ask, runs a coding harness in the connected repo, opens an implementing GitHub PR, and links it back to the issue.',
    highlights: [
      'Triggers on new Granola notes under /granola/notes/.',
      'Detects prospect/sales asks and ignores everything else.',
      'Files a Linear issue, then opens an implementing GitHub PR.',
      'Keeps discovery from dying in meeting notes.',
    ],
    trigger: {
      kind: 'event',
      summary: 'When a new Granola note lands',
      detail: 'file.created · /granola/notes/',
    },
    integrations: ['granola', 'linear', 'github'],
    runtime: 'Claude · claude-sonnet-4-6',
    inputs: ['LINEAR_TEAM_ID'],
    accent: '#b45542',
    hasCustomArt: true,
  },
  {
    slug: 'linear',
    personaId: 'linear-chat-lead',
    dir: 'linear',
    name: 'Linear Implementer',
    tagline: 'Turns Linear issues and mentions into implementation PRs.',
    description:
      'Owns the Linear agent-session chat and implementation delegation. It replies in Linear threads, classifies whether you want discussion or code, starts a coding workflow for implementation requests, and comments the resulting GitHub PR link back to the issue — keeping planning and building in one place.',
    highlights: [
      'Implements matching issues automatically on creation.',
      'Answers follow-up prompts in the Linear agent session.',
      'Delegates code changes to a coding workflow that opens a GitHub PR.',
      'Stores per-session memory keyed by Linear session id.',
    ],
    trigger: {
      kind: 'event',
      summary: 'On Linear issues, comments & mentions',
      detail: 'issue.create (agentrelay) · comment · agent-session',
    },
    integrations: ['linear'],
    runtime: 'gpt-5.5',
    inputs: ['MENTION'],
    accent: '#5e6ad2',
    hasCustomArt: true,
  },
  {
    slug: 'hn-monitor',
    personaId: 'hn-monitor',
    dir: 'hn-monitor',
    name: 'Hacker News Monitor',
    tagline: 'Scans Hacker News twice a day and posts only the stories your team cares about.',
    description:
      'Checks Hacker News for your configured topic keywords, summarizes the matching stories into a short Slack digest, and remembers which story ids it has already posted so overlapping topics and repeated cron fires never spam the same links.',
    highlights: [
      'Watches HN titles for your comma-separated topics.',
      'Runs twice a day on a schedule (9am & 5pm).',
      'Posts a concise, skimmable Slack digest.',
      'Dedupes with workspace memory so nothing reposts.',
    ],
    trigger: {
      kind: 'schedule',
      summary: 'Twice a day · 9am & 5pm ET',
      detail: '0 9,17 * * *',
    },
    integrations: ['slack', 'hacker-news'],
    runtime: 'Claude · claude-haiku-4-5',
    inputs: ['TOPICS', 'SLACK_CHANNEL'],
    accent: '#c1674b',
    hasCustomArt: true,
  },
  {
    slug: 'vendor-monitor',
    personaId: 'vendor-monitor',
    dir: 'vendor-monitor',
    name: 'Vendor Monitor',
    tagline: 'Watches your stack for dependency releases and tells the team what changed.',
    description:
      'Tracks the npm packages your stack depends on and posts version changes to a team Slack channel each weekday morning. It remembers the last-seen version map so it only reports genuinely new bumps after the initial baseline.',
    highlights: [
      'Tracks configured npm packages across your stack.',
      'Compares against a remembered version map.',
      'Posts only changed packages to Slack — no noise.',
      'Runs weekday mornings on a schedule.',
    ],
    trigger: {
      kind: 'schedule',
      summary: 'Weekday mornings · 8am ET',
      detail: '0 8 * * 1-5',
    },
    integrations: ['slack', 'npm'],
    runtime: 'Default harness',
    inputs: ['VENDORS', 'SLACK_CHANNEL'],
    accent: '#2d6a9c',
    hasCustomArt: true,
  },
  {
    slug: 'spotify-releases',
    personaId: 'spotify-releases',
    dir: 'spotify-releases',
    name: 'Spotify Releases',
    tagline: 'DMs you when artists you follow ship new music.',
    description:
      'Checks the artists followed by your Spotify account for newly released albums and singles. When it finds releases newer than its last check, it sends you a Slack DM with the links — a delightful example of a personal proactive agent.',
    highlights: [
      'Checks your followed artists daily for new releases.',
      'Filters by the last-check date held in memory.',
      'DMs you on Slack with links the day music drops.',
      'A friendly, personal proactive agent.',
    ],
    trigger: {
      kind: 'schedule',
      summary: 'Every day · 10am ET',
      detail: '0 10 * * *',
    },
    integrations: ['spotify', 'slack'],
    runtime: 'Default harness',
    inputs: ['SLACK_USER', 'SPOTIFY_TOKEN'],
    accent: '#1db954',
    hasCustomArt: true,
  },
];

// ── Use cases ───────────────────────────────────────────────────────────────
// The proactive jobs these agents do for you, grouped by theme.

export interface UseCase {
  title: string;
  description: string;
  /** Agent slugs that deliver this use case. May reference non-public agents. */
  agents: string[];
}

export interface UseCaseGroup {
  theme: string;
  blurb: string;
  cases: UseCase[];
}

/** Display names for agents referenced in use cases that have no detail page. */
export const NON_PUBLIC_AGENT_LABELS: Record<string, string> = {
  'cloud-team-implementer': 'Cloud Team Implementer',
  'cloud-team-reviewer': 'Cloud Team Reviewer',
};

export const USE_CASE_GROUPS: UseCaseGroup[] = [
  {
    theme: 'Keep pull requests moving',
    blurb: 'Agents that live in your repo and move pull requests from opened to merged.',
    cases: [
      {
        title: 'Review every new or updated PR automatically',
        description:
          'When a PR opens or gets new commits, run a senior review pass and post findings so the author never waits on a manual first review.',
        agents: ['review', 'repo-hygiene'],
      },
      {
        title: 'Fix review findings without another handoff',
        description:
          'After finding issues, push fixes straight to the PR branch instead of just leaving comments — including cleaning up other bots’ comments.',
        agents: ['review'],
      },
      {
        title: 'Unblock PRs with failing CI or merge conflicts',
        description:
          'Inspect the checkout when checks fail or comments arrive, resolve failures and conflicts where possible, and flag when a human is actually needed.',
        agents: ['review'],
      },
      {
        title: 'Notify the right person, then merge on approval',
        description:
          'Send a threaded Slack update when the PR is ready, and merge automatically once an authorized approver signs off.',
        agents: ['review'],
      },
    ],
  },
  {
    theme: 'Prevent codebase entropy',
    blurb: 'A hygiene reviewer that keeps quality from sliding as the codebase grows.',
    cases: [
      {
        title: 'Catch duplicated or dead code during review',
        description:
          'Diagnose PRs for duplicated implementation paths, dead code, stale docs/skills/rules, and concrete code smells before the change lands.',
        agents: ['repo-hygiene'],
      },
      {
        title: 'Build a hygiene audit trail in Notion',
        description:
          'Create a Notion journal page per run so maintainers can see what was flagged, what repeated, and where divergence is accumulating.',
        agents: ['repo-hygiene'],
      },
      {
        title: 'Track repeated issues with memory',
        description:
          'Recall prior hygiene runs for the same repo and use workspace memory to spot recurring divergence instead of treating each PR as isolated.',
        agents: ['repo-hygiene'],
      },
    ],
  },
  {
    theme: 'Turn work requests into implementation PRs',
    blurb: 'Agents that take a request — in Linear or on a call — and open the PR that does it.',
    cases: [
      {
        title: 'Implement labeled Linear issues automatically',
        description:
          'When a matching Linear issue is created, classify it and start a coding workflow that opens a GitHub PR and comments the link back to Linear.',
        agents: ['linear'],
      },
      {
        title: 'Answer Linear mentions with replies or code',
        description:
          'When mentioned in a Linear comment or agent session, keep thread memory, decide between discussion and implementation, then reply or delegate coding.',
        agents: ['linear'],
      },
      {
        title: 'Route prospect feature asks straight into engineering',
        description:
          'When a Granola note arrives, detect a prospect feature ask, create the Linear issue, implement the change, open the PR, and link it back.',
        agents: ['granola'],
      },
    ],
  },
  {
    theme: 'Stay current without manual checking',
    blurb: 'Monitoring agents that watch the outside world and bring only the signal to you.',
    cases: [
      {
        title: 'Monitor Hacker News for your topics',
        description:
          'Twice a day, scan HN titles for configured keywords, summarize fresh matches, and post a Slack digest — deduped so nothing reposts.',
        agents: ['hn-monitor'],
      },
      {
        title: 'Track vendor and framework releases',
        description:
          'Each weekday morning, check configured npm packages against remembered versions and post only the changed packages to Slack.',
        agents: ['vendor-monitor'],
      },
      {
        title: 'Get personal music release alerts',
        description:
          'Daily, check followed Spotify artists for new albums or singles and DM you the release links newer than the last check.',
        agents: ['spotify-releases'],
      },
    ],
  },
  {
    theme: 'Coordinate multi-agent teams',
    blurb: 'Split a single issue across specialized agents that implement and review in parallel.',
    cases: [
      {
        title: 'Split issue solving into implement + review roles',
        description:
          'A team lead can launch a roster where one agent implements the issue in a sandbox and another audits the branch against the spec before handoff.',
        agents: ['cloud-team-implementer', 'cloud-team-reviewer'],
      },
      {
        title: 'Keep each roster member focused',
        description:
          'The implementer makes the smallest complete change and opens one PR; the reviewer verifies tests and classifies actionable findings.',
        agents: ['cloud-team-implementer', 'cloud-team-reviewer'],
      },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_REPO = 'AgentWorkforce/agents';

export function getAgent(slug: string): Agent | undefined {
  return AGENTS.find((a) => a.slug === slug);
}

export function allAgentSlugs(): string[] {
  return AGENTS.map((a) => a.slug);
}

export function agentAsset(slug: string, asset: 'banner' | 'card' | 'card-sm'): string {
  return `/agents/${slug}/${asset}.png`;
}

function agentRepo(agent: Agent): string {
  return agent.repo ?? DEFAULT_REPO;
}

/** View the agent source on GitHub. */
export function sourceUrl(agent: Agent): string {
  return `https://github.com/${agentRepo(agent)}/tree/main/${agent.dir}`;
}

/** Fork the agent's repo on GitHub. */
export function forkUrl(agent: Agent): string {
  return `https://github.com/${agentRepo(agent)}/fork`;
}

/** GitHub blob URL to the agent's persona definition file. */
function personaUrl(agent: Agent): string {
  const file = agent.personaFile ?? 'persona.ts';
  return `https://github.com/${agentRepo(agent)}/blob/main/${agent.dir}/${file}`;
}

/**
 * One-click deploy on Agent Relay Cloud. The deploy page takes a `persona`
 * pointing at the persona definition on GitHub, e.g.
 * https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts
 */
export function launchUrl(agent: Agent): string {
  return `https://agentrelay.com/cloud/deploy?persona=${personaUrl(agent)}`;
}
