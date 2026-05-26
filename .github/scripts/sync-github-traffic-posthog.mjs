#!/usr/bin/env node

const DEFAULT_GITHUB_API_VERSION = '2022-11-28';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';
const GITHUB_TRAFFIC_WINDOW_DAYS = 14;
const DEFAULT_DAILY_LAG_HOURS = 8;
const REQUEST_TIMEOUT_MS = 15_000;

function readEnv(name, fallback = undefined) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function requireEnv(name) {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeHost(host) {
  return host.replace(/\/+$/, '');
}

function parseRepository(repository) {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Expected repository in owner/name form, got "${repository}"`);
  }
  return { owner, repo };
}

function dayFromTimestamp(timestamp) {
  return timestamp.slice(0, 10);
}

function utcNoonForDay(day) {
  return `${day}T12:00:00Z`;
}

function parseNonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function dailyCutoffDay(lagHours) {
  const cutoff = new Date(Date.now() - lagHours * 60 * 60 * 1000);
  return dayFromTimestamp(cutoff.toISOString());
}

function runIdentity() {
  const runId = readEnv('GITHUB_RUN_ID');
  const runAttempt = readEnv('GITHUB_RUN_ATTEMPT');
  if (runId && runAttempt) {
    return `${runId}:${runAttempt}`;
  }
  return readEnv('GITHUB_TRAFFIC_RUN_ID', new Date().toISOString());
}

function baseProperties({ repository, owner, repo, capturedAt, distinctId, apiVersion }) {
  return {
    source: 'github_actions',
    repository,
    github_owner: owner,
    github_repo: repo,
    github_api_version: apiVersion,
    github_traffic_window_days: GITHUB_TRAFFIC_WINDOW_DAYS,
    captured_at: capturedAt,
    distinct_id: distinctId,
    $groups: {
      repository,
    },
    $process_person_profile: false,
  };
}

function postHogEvent({ event, distinctId, timestamp, properties }) {
  return {
    event,
    distinct_id: distinctId,
    timestamp,
    properties: {
      ...properties,
      distinct_id: distinctId,
    },
  };
}

async function githubGetJson({ owner, repo, path, githubToken, apiVersion }) {
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}${path}`);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${githubToken}`,
      'X-GitHub-Api-Version': apiVersion,
      'User-Agent': 'agent-relay-github-traffic-posthog',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    const hint =
      response.status === 401 || response.status === 403
        ? '\nGitHub traffic endpoints require repository write access or a fine-grained token with Administration: read. Configure GH_TRAFFIC_TOKEN as a repository secret.'
        : '';
    throw new Error(`GitHub API ${response.status} for ${path}: ${body}${hint}`);
  }

  return response.json();
}

function buildDailyTrafficEvents({
  repository,
  owner,
  repo,
  distinctId,
  capturedAt,
  apiVersion,
  views,
  clones,
  includePartialDay,
  dailyLagHours,
}) {
  const today = dayFromTimestamp(new Date().toISOString());
  const cutoffDay = dailyCutoffDay(dailyLagHours);
  const byDay = new Map();

  for (const item of views.views ?? []) {
    const day = dayFromTimestamp(item.timestamp);
    byDay.set(day, {
      ...(byDay.get(day) ?? {}),
      day,
      github_timestamp: item.timestamp,
      view_count: item.count,
      view_uniques: item.uniques,
      has_views: true,
    });
  }

  for (const item of clones.clones ?? []) {
    const day = dayFromTimestamp(item.timestamp);
    byDay.set(day, {
      ...(byDay.get(day) ?? {}),
      day,
      github_timestamp: item.timestamp,
      clone_count: item.count,
      clone_uniques: item.uniques,
      has_clones: true,
    });
  }

  const base = baseProperties({ repository, owner, repo, capturedAt, distinctId, apiVersion });
  return [...byDay.values()]
    .filter((item) => includePartialDay || item.day < cutoffDay)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((item) =>
      postHogEvent({
        event: 'github_repo_traffic_daily',
        distinctId,
        timestamp: utcNoonForDay(item.day),
        properties: {
          ...base,
          traffic_period: 'day',
          traffic_date: item.day,
          daily_cutoff_date: cutoffDay,
          daily_lag_hours: dailyLagHours,
          github_timestamp: item.github_timestamp ?? `${item.day}T00:00:00Z`,
          view_count: item.view_count ?? 0,
          view_uniques: item.view_uniques ?? 0,
          clone_count: item.clone_count ?? 0,
          clone_uniques: item.clone_uniques ?? 0,
          has_views: Boolean(item.has_views),
          has_clones: Boolean(item.has_clones),
          includes_partial_day: item.day >= today,
          $insert_id: `github_repo_traffic_daily:${repository}:${item.day}`,
        },
      })
    );
}

function availableWindow({ views, clones }) {
  const days = [
    ...(views.views ?? []).map((item) => dayFromTimestamp(item.timestamp)),
    ...(clones.clones ?? []).map((item) => dayFromTimestamp(item.timestamp)),
  ].sort();

  return {
    window_start_date: days[0] ?? null,
    window_end_date: days[days.length - 1] ?? null,
    available_day_count: new Set(days).size,
  };
}

function buildSnapshotEvents({
  repository,
  owner,
  repo,
  distinctId,
  capturedAt,
  apiVersion,
  views,
  clones,
  paths,
  referrers,
  dailyEvents,
}) {
  const base = baseProperties({ repository, owner, repo, capturedAt, distinctId, apiVersion });
  const runKey = runIdentity();
  const window = availableWindow({ views, clones });
  const today = dayFromTimestamp(new Date().toISOString());
  const includesPartialDay = window.window_end_date === today;

  const snapshot = postHogEvent({
    event: 'github_repo_traffic_window_snapshot',
    distinctId,
    timestamp: capturedAt,
    properties: {
      ...base,
      traffic_period: 'last_14_days',
      ...window,
      includes_partial_day: includesPartialDay,
      daily_events_sent: dailyEvents.length,
      view_count: views.count ?? 0,
      view_uniques: views.uniques ?? 0,
      clone_count: clones.count ?? 0,
      clone_uniques: clones.uniques ?? 0,
      top_path_count: paths.length,
      top_referrer_count: referrers.length,
      raw_views_daily: views.views ?? [],
      raw_clones_daily: clones.clones ?? [],
      $insert_id: `github_repo_traffic_window_snapshot:${repository}:${runKey}`,
    },
  });

  const pathEvents = paths.map((item, index) =>
    postHogEvent({
      event: 'github_repo_traffic_path_snapshot',
      distinctId,
      timestamp: capturedAt,
      properties: {
        ...base,
        traffic_period: 'last_14_days',
        rank: index + 1,
        path: item.path,
        title: item.title,
        view_count: item.count ?? 0,
        view_uniques: item.uniques ?? 0,
        $insert_id: `github_repo_traffic_path_snapshot:${repository}:${runKey}:${index + 1}:${item.path}`,
      },
    })
  );

  const referrerEvents = referrers.map((item, index) =>
    postHogEvent({
      event: 'github_repo_traffic_referrer_snapshot',
      distinctId,
      timestamp: capturedAt,
      properties: {
        ...base,
        traffic_period: 'last_14_days',
        rank: index + 1,
        referrer: item.referrer,
        view_count: item.count ?? 0,
        view_uniques: item.uniques ?? 0,
        $insert_id: `github_repo_traffic_referrer_snapshot:${repository}:${runKey}:${index + 1}:${item.referrer}`,
      },
    })
  );

  return [snapshot, ...pathEvents, ...referrerEvents];
}

async function sendPostHogBatch({ host, apiKey, events }) {
  const response = await fetch(`${normalizeHost(host)}/batch/`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      historical_migration: true,
      batch: events,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PostHog batch API ${response.status}: ${body}`);
  }
}

async function main() {
  const repository = readEnv('GITHUB_REPOSITORY_NAME', readEnv('GITHUB_REPOSITORY'));
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY_NAME or GITHUB_REPOSITORY is required');
  }

  const { owner, repo } = parseRepository(repository);
  const githubToken = requireEnv('GITHUB_TOKEN');
  const apiVersion = readEnv('GITHUB_API_VERSION', DEFAULT_GITHUB_API_VERSION);
  const posthogHost = readEnv('POSTHOG_HOST', DEFAULT_POSTHOG_HOST);
  const dryRun = readEnv('POSTHOG_DRY_RUN', 'false') === 'true';
  const posthogApiKey = dryRun
    ? readEnv('POSTHOG_PROJECT_API_KEY', 'dry-run')
    : requireEnv('POSTHOG_PROJECT_API_KEY');
  const includePartialDay = readEnv('GITHUB_TRAFFIC_INCLUDE_PARTIAL_DAY', 'false') === 'true';
  const dailyLagHours = parseNonNegativeNumber(
    readEnv('GITHUB_TRAFFIC_DAILY_LAG_HOURS', String(DEFAULT_DAILY_LAG_HOURS)),
    'GITHUB_TRAFFIC_DAILY_LAG_HOURS'
  );
  const capturedAt = new Date().toISOString();
  const distinctId = `github_repo:${repository}`;

  const request = { owner, repo, githubToken, apiVersion };
  const [views, clones, paths, referrers] = await Promise.all([
    githubGetJson({ ...request, path: '/traffic/views?per=day' }),
    githubGetJson({ ...request, path: '/traffic/clones?per=day' }),
    githubGetJson({ ...request, path: '/traffic/popular/paths' }),
    githubGetJson({ ...request, path: '/traffic/popular/referrers' }),
  ]);

  const common = { repository, owner, repo, distinctId, capturedAt, apiVersion };
  const dailyEvents = buildDailyTrafficEvents({ ...common, views, clones, includePartialDay, dailyLagHours });
  const snapshotEvents = buildSnapshotEvents({ ...common, views, clones, paths, referrers, dailyEvents });
  const events = [...dailyEvents, ...snapshotEvents];

  if (events.length === 0) {
    console.log(`No GitHub traffic events to send for ${repository}`);
    return;
  }

  if (dryRun) {
    console.log(`Dry run: built ${events.length} GitHub traffic events for ${repository}`);
    console.log(JSON.stringify({ event_count: events.length, events }, null, 2));
    return;
  }

  await sendPostHogBatch({ host: posthogHost, apiKey: posthogApiKey, events });
  console.log(
    `Sent ${events.length} GitHub traffic events for ${repository} to PostHog (${dailyEvents.length} daily, ${snapshotEvents.length} snapshots)`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
