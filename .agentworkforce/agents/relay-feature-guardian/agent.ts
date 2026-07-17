/**
 * relay-feature-guardian handler.
 *
 * Hourly cron tick:
 *   1. Read the feature list from the cloned relay repository
 *   2. Load feature progress from memory
 *   3. Pick the next unchecked feature (ordered by criticality then tier)
 *   4. Generate a concise quiz question via ctx.llm
 *   5. Post to Slack with @mentions for Will and Khaliq
 *   6. Persist updated progress
 *
 * After the full manifest is covered, the cycle resets.
 */
import { defineAgent, type WorkforceCtx } from '@agentworkforce/runtime';
import { input } from '@agentworkforce/delivery';
import { slackClient } from '@relayfile/relay-helpers';
import { parse } from 'yaml';

// ── manifest types ────────────────────────────────────────────────────────────

type Criticality = 'critical' | 'hot' | 'standard';

interface ManifestFeature {
  id: string;
  name: string;
  cli: string;
  description: string;
  verify_tier: number;
  mcp?: string;
  location?: string;
}

interface ManifestCategory {
  name: string;
  description?: string;
  criticality: Criticality;
  features: ManifestFeature[];
}

interface Manifest {
  version: string;
  categories: Record<string, ManifestCategory>;
}

// ── feature (flattened view used by this agent) ───────────────────────────────

interface Feature {
  id: string;
  name: string;
  cli: string;
  desc: string;
  tier: number;
  criticality: Criticality;
  mcp?: string;
}

const MANIFEST_RELPATH = '.agentworkforce/features/manifest.yaml';
const RELAY_REPO_RELPATH = 'github/repos/AgentWorkforce/relay';

/**
 * GitHub-scoped repositories are cloned beneath the proactive workspace root.
 * WorkforceCtx currently exposes that workspace root (`sandbox.cwd`), but not
 * an integration-specific repository directory, so derive the clone path from
 * the documented `/github/repos/{owner}/{repo}` layout.
 */
export function resolveManifestPath(workspaceDir: string): string {
  return `${workspaceDir}/${RELAY_REPO_RELPATH}/${MANIFEST_RELPATH}`;
}

async function loadFeatures(ctx: WorkforceCtx): Promise<Feature[]> {
  const absPath = resolveManifestPath(ctx.sandbox.cwd);
  const raw = await ctx.sandbox.readFile(absPath);
  const manifest = parse(raw) as Manifest;
  const features: Feature[] = [];
  for (const category of Object.values(manifest.categories)) {
    for (const f of category.features ?? []) {
      features.push({
        id: f.id,
        name: f.name,
        cli: f.cli,
        desc: f.description,
        tier: f.verify_tier,
        criticality: category.criticality,
        mcp: f.mcp,
      });
    }
  }
  return features;
}

// ── progress tracking ─────────────────────────────────────────────────────────

interface ProgressState {
  kind: 'relay-feature-guardian:progress';
  version: 1;
  checkedIds: string[];
  cycleStartedAt: string;
  totalFeatures: number;
}

async function loadProgress(ctx: WorkforceCtx): Promise<ProgressState | null> {
  const items = await ctx.memory.recall('relay-feature-guardian cycle progress', {
    tags: ['relay-feature-guardian:progress'],
    scope: 'workspace',
    limit: 5,
  });
  for (const item of [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))) {
    try {
      const parsed = JSON.parse(item.content) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as ProgressState).kind === 'relay-feature-guardian:progress'
      ) {
        return parsed as ProgressState;
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

async function saveProgress(ctx: WorkforceCtx, state: ProgressState): Promise<void> {
  await ctx.memory.save(JSON.stringify(state), {
    tags: ['relay-feature-guardian:progress'],
    scope: 'workspace',
    ttlSeconds: 60 * 60 * 24 * 14, // 14 days
  });
}

// ── feature selection ─────────────────────────────────────────────────────────

function pickNextFeature(features: Feature[], checkedIds: Set<string>): Feature | null {
  const critOrder: Record<Criticality, number> = { critical: 0, hot: 1, standard: 2 };
  const ordered = [...features].sort((a, b) => {
    const critDiff = critOrder[a.criticality] - critOrder[b.criticality];
    if (critDiff !== 0) return critDiff;
    return a.tier - b.tier;
  });
  return ordered.find((f) => !checkedIds.has(f.id)) ?? null;
}

// ── quiz generation ───────────────────────────────────────────────────────────

async function generateQuizMessage(ctx: WorkforceCtx, feature: Feature): Promise<string> {
  const mcpNote = feature.mcp ? `\nMCP tool: \`${feature.mcp}\`` : '';
  const tierLabel =
    feature.tier === 1
      ? 'no broker needed'
      : feature.tier === 2
        ? 'broker required'
        : feature.tier === 3
          ? 'broker + agent token'
          : feature.tier === 4
            ? 'broker + two agents'
            : 'cloud auth required';

  const prompt = [
    'You are the Relay Feature Guardian, a proactive Slack bot for the Agent Relay team.',
    'Write a brief, conversational Slack message (3-5 sentences, no markdown headers) asking the team to confirm whether a specific CLI feature is working as intended.',
    'Be specific: name the feature, describe what it should do, show the CLI command, and ask if it behaves this way or if anything has drifted.',
    'End with: "React ✅ if working as expected, 🔧 if something is off, or ❓ if untested."',
    'Keep it casual and direct — this is an internal team check.',
    '',
    `Feature: ${feature.name}`,
    `CLI: ${feature.cli}${mcpNote}`,
    `What it should do: ${feature.desc}`,
    `Verify tier: ${feature.tier} (${tierLabel})`,
    `Criticality: ${feature.criticality}`,
  ].join('\n');

  try {
    const output = await ctx.llm.complete(prompt, { maxTokens: 300 });
    return output.trim();
  } catch {
    return [
      `🔍 *Relay Feature Check: ${feature.name}*`,
      ``,
      `\`${feature.cli}\`${mcpNote}`,
      ``,
      `This should: ${feature.desc}`,
      ``,
      `Is this working as expected right now? React ✅ if yes, 🔧 if something is off, or ❓ if untested.`,
    ].join('\n');
  }
}

// ── agent definition ──────────────────────────────────────────────────────────

export default defineAgent({
  schedules: [{ name: 'hourly-check', cron: '0 * * * *', tz: 'America/New_York' }],
  handler: async (ctx, _event) => {
    const channel = input(ctx, 'SLACK_CHANNEL');
    if (!channel) {
      ctx.log('warn', 'relay-feature-guardian.no-channel', { reason: 'SLACK_CHANNEL not configured' });
      return;
    }

    // Load the live feature list from the manifest
    let features: Feature[];
    try {
      features = await loadFeatures(ctx);
    } catch (err) {
      const absPath = resolveManifestPath(ctx.sandbox.cwd);
      ctx.log('error', 'relay-feature-guardian.manifest-load-failed', { path: absPath, err: String(err) });
      const isNotFound = String(err).includes('ENOENT');
      const errMsg = isNotFound
        ? `⚠️ *relay-feature-guardian* can't find the feature manifest in the cloned relay repository at \`${RELAY_REPO_RELPATH}/${MANIFEST_RELPATH}\`.`
        : `⚠️ *relay-feature-guardian* failed to load the feature manifest: \`${String(err)}\``;
      await slackClient()
        .post(channel, errMsg)
        .catch(() => undefined);
      return;
    }
    ctx.log('info', 'relay-feature-guardian.manifest-loaded', {
      path: resolveManifestPath(ctx.sandbox.cwd),
      features: features.length,
    });
    if (features.length === 0) {
      ctx.log('error', 'relay-feature-guardian.no-features', { reason: 'manifest parsed but empty' });
      await slackClient()
        .post(
          channel,
          '⚠️ *relay-feature-guardian* loaded the manifest but found no features. Check `.agentworkforce/features/manifest.yaml`.'
        )
        .catch(() => undefined);
      return;
    }

    // Load progress or bootstrap a fresh cycle
    const progress = await loadProgress(ctx);
    const checkedIds = new Set(progress?.checkedIds ?? []);
    const totalFeatures = features.length;

    // Pick the next unchecked feature; reset if the cycle is complete
    let feature = pickNextFeature(features, checkedIds);
    if (!feature) {
      ctx.log('info', 'relay-feature-guardian.cycle-complete', { total: totalFeatures });
      checkedIds.clear();
      feature = pickNextFeature(features, checkedIds);
    }
    if (!feature) return;

    // Build @mention string
    const userWill = input(ctx, 'SLACK_USER_WILL');
    const userKhaliq = input(ctx, 'SLACK_USER_KHALIQ');
    const mentions = [userWill && `<@${userWill}>`, userKhaliq && `<@${userKhaliq}>`]
      .filter(Boolean)
      .join(' ');
    const mentionPrefix = mentions ? `${mentions} — ` : '';

    // Generate quiz message
    const quizBody = await generateQuizMessage(ctx, feature);
    const remaining = totalFeatures - checkedIds.size - 1;
    const progressNote = `_[relay feature check · ${checkedIds.size + 1}/${totalFeatures} · ${remaining} remaining in cycle]_`;
    const message = [mentionPrefix + quizBody, '', progressNote].join('\n');

    // Post to Slack
    const slack = slackClient();
    const result = await slack.post(channel, message);
    if (!result.ts) {
      ctx.log('error', 'relay-feature-guardian.post-failed', { channel, feature: feature.id });
      return;
    }
    ctx.log('info', 'relay-feature-guardian.posted', { channel, feature: feature.id, ts: result.ts });

    // Persist updated progress
    checkedIds.add(feature.id);
    await saveProgress(ctx, {
      kind: 'relay-feature-guardian:progress',
      version: 1,
      checkedIds: [...checkedIds],
      cycleStartedAt: progress?.cycleStartedAt ?? new Date().toISOString(),
      totalFeatures,
    });
  },
});
