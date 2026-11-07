/**
 * Generate a deterministic Flows v2 spec containing only the verification
 * scenarios selected for a pull request. The selector owns feature routing;
 * this file only translates its validated command plan into a journaled DAG.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

type CommandSpec = {
  id: string;
  laneId: string;
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  timeoutSeconds: number;
  requiredCommands?: string[];
  requiredEnvironment?: string[];
  expectedExitCodes?: number[];
  mustContain?: string[];
  forbidOutput?: string[];
};

type TargetedPlan = {
  version: number;
  kind: string;
  mode: 'skip' | 'targeted' | 'full-smoke';
  setup: CommandSpec[];
  scenarios: CommandSpec[];
  environmentDefaults?: Record<string, string>;
  isolatedEnvironment?: Record<string, string>;
};

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stepId(kind: string, laneId: string, id: string): string {
  return `${kind}-${laneId}-${id}`.replace(/[^a-z0-9-]/g, '-').slice(0, 120);
}

function replaceTemplates(value: string, roots: Record<string, string>): string {
  return value.replace(
    /\{\{(repoRoot|fixtureRoot|laneRoot|brokerBinary)\}\}/g,
    (_, key: string) => roots[key]
  );
}

function commandFor(spec: CommandSpec, plan: TargetedPlan, repoRoot: string, fixtureRoot: string): string {
  const laneRoot = path.join(fixtureRoot, spec.laneId);
  const roots = {
    repoRoot,
    fixtureRoot,
    laneRoot,
    brokerBinary: path.join(repoRoot, 'target', 'release', 'agent-relay-broker'),
  };
  const cwd = replaceTemplates(spec.cwd ?? repoRoot, roots);
  const environment = {
    ...(plan.environmentDefaults ?? {}),
    ...Object.fromEntries(
      Object.entries(plan.isolatedEnvironment ?? {}).map(([name, relative]) => [
        name,
        path.join(laneRoot, relative),
      ])
    ),
    ...(spec.environment ?? {}),
  };
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      argv: spec.command.map((entry) => replaceTemplates(entry, roots)),
      cwd,
      environment: Object.fromEntries(
        Object.entries(environment)
          .sort(([left], [right]) => left.localeCompare(right, 'en'))
          .map(([name, value]) => [name, replaceTemplates(value, roots)])
      ),
      timeoutSeconds: spec.timeoutSeconds,
      requiredCommands: spec.requiredCommands ?? [],
      requiredEnvironment: spec.requiredEnvironment ?? [],
      expectedExitCodes: spec.expectedExitCodes ?? [0],
      mustContain: spec.mustContain ?? [],
      forbidOutput: spec.forbidOutput ?? [],
    })
  ).toString('base64url');
  return (
    `mkdir -p ${shellQuote(laneRoot)} ${shellQuote(cwd)} && ` +
    `node scripts/verify-features/targeted-command.mjs --payload ${shellQuote(payload)}`
  );
}

async function main(): Promise<void> {
  const planPath = path.resolve(option('--plan'));
  const outputPath = path.resolve(option('--out', '.workflow-artifacts/flows/relay.verify.targeted-pr.json'));
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as TargetedPlan;
  if (plan.version !== 1 || plan.kind !== 'relay-targeted-pr-plan') {
    throw new Error('targeted plan identity is invalid');
  }
  if (!['skip', 'targeted', 'full-smoke'].includes(plan.mode))
    throw new Error('targeted plan mode is invalid');

  const repoRoot = process.cwd();
  const fixtureRoot = path.resolve(
    process.env.RUNNER_TEMP ?? '.workflow-artifacts/targeted-feature-verification',
    'relay-targeted-feature-fixtures'
  );
  const steps: Array<Record<string, unknown>> = [
    {
      id: 'validate-targeted-plan',
      type: 'deterministic',
      command: `node scripts/verify-features/targeted-pr-plan.mjs validate --plan ${shellQuote(planPath)}`,
      timeoutMs: 30_000,
    },
  ];
  let previous = 'validate-targeted-plan';
  const commands = plan.mode === 'skip' ? [] : [...plan.setup, ...plan.scenarios];
  for (const [index, spec] of commands.entries()) {
    const kind = index < plan.setup.length ? 'setup' : 'scenario';
    const id = stepId(kind, spec.laneId, spec.id);
    steps.push({
      id,
      type: 'deterministic',
      dependsOn: [previous],
      command: commandFor(spec, plan, repoRoot, fixtureRoot),
      timeoutMs: (spec.timeoutSeconds + 30) * 1_000,
    });
    previous = id;
  }
  if (plan.mode === 'skip') {
    steps.push({
      id: 'no-targeted-features',
      type: 'deterministic',
      dependsOn: [previous],
      command: "echo 'TARGETED_FEATURE_VERIFICATION_SKIPPED no affected runtime feature'",
      timeoutMs: 30_000,
    });
    previous = 'no-targeted-features';
  }
  steps.push({
    id: 'targeted-verdict',
    type: 'deterministic',
    dependsOn: [previous],
    command: `echo ${shellQuote(`TARGETED_FEATURE_VERIFICATION_PASS mode=${plan.mode} scenarios=${plan.scenarios.length}`)}`,
    timeoutMs: 30_000,
  });

  const commandBudget = commands.reduce((total, spec) => total + (spec.timeoutSeconds + 30) * 1_000, 0);
  const flow = {
    version: '0.1.0',
    name: 'relay.verify.targeted-pr',
    description:
      'Run the smallest fail-closed Flows v2 verification slice selected from changed files and the feature manifest.',
    budget: { maxWallclockMs: Math.max(300_000, commandBudget + 300_000) },
    steps,
  };
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(flow, null, 2)}\n`);
  console.log(`TARGETED_PR_SPEC_WRITTEN ${outputPath} steps=${steps.length} mode=${plan.mode}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
