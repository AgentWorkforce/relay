import type { BridgeProject, CoreDependencies, CoreRelay } from '../commands/core.js';

type BridgeCommandOptions = {
  cli?: string;
  architect?: string | boolean;
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatProjectContext(projects: BridgeProject[]): string {
  return projects
    .map((project) => `- ${project.id}: ${project.path} (Lead: ${project.leadName})`)
    .join('\n');
}

async function cleanupRelays(relays: Map<string, CoreRelay>): Promise<void> {
  await Promise.all(
    Array.from(relays.values()).map((relay) => relay.shutdown().catch(() => undefined))
  );
}

export async function runBridgeCommand(
  projectPaths: string[],
  options: BridgeCommandOptions,
  deps: CoreDependencies
): Promise<void> {
  const projects = deps.resolveBridgeProjects(projectPaths, options.cli);

  if (projects.length === 0) {
    deps.error('No projects specified.');
    deps.error('Usage: agent-relay bridge ~/project1 ~/project2');
    deps.error('   or: Create ~/.agent-relay/bridge.json with project config');
    deps.exit(1);
    return;
  }

  deps.log('Bridge Mode - Multi-Project Orchestration');
  deps.log('─'.repeat(40));

  const { valid, missing } = deps.validateBridgeDaemons(projects);
  if (missing.length > 0) {
    deps.error('');
    deps.error('Missing brokers for:');
    for (const project of missing) {
      deps.error(`  - ${project.path}`);
      deps.error(`    Run: cd "${project.path}" && agent-relay up`);
    }
    deps.error('');
  }

  if (valid.length === 0) {
    deps.error('No projects have running brokers. Start them first.');
    deps.exit(1);
    return;
  }

  const relays = new Map<string, CoreRelay>();
  for (const project of valid) {
    const relay = deps.createRelay(project.path);
    try {
      await relay.getStatus();
      relays.set(project.id, relay);
      deps.log(`Connected: ${project.id} (${project.path})`);
    } catch (err: unknown) {
      deps.error(`Failed to connect to ${project.id}: ${toErrorMessage(err)}`);
      await relay.shutdown().catch(() => undefined);
    }
  }

  if (relays.size === 0) {
    deps.error('Failed to connect to all projects.');
    deps.exit(1);
    return;
  }

  if (options.architect !== undefined) {
    const architectCli =
      typeof options.architect === 'string' && options.architect.trim().length > 0
        ? options.architect.trim()
        : 'claude';

    const baseProject = valid[0];
    const relay = relays.get(baseProject.id);

    if (relay) {
      const modelSplit = architectCli.split(':');
      const cli = modelSplit[0];
      const model = modelSplit[1];
      const outboxPath = deps.getAgentOutboxTemplate().replace(/\$/g, '\\$');
      const prompt =
        'You are the Architect, a cross-project coordinator.\n\n' +
        `Connected Projects:\n${formatProjectContext(valid)}\n\n` +
        `Use relay protocol with outbox path ${outboxPath}. Start by asking each lead for status.`;

      try {
        await relay.spawn({
          name: 'Architect',
          cli,
          args: model ? ['--model', model] : [],
          channels: ['general'],
          task: prompt,
        });
        deps.log('Architect agent started.');
      } catch (err: unknown) {
        deps.error(`Failed to spawn Architect agent: ${toErrorMessage(err)}`);
      }
    }
  }

  const shutdown = async () => {
    await cleanupRelays(relays);
  };

  deps.onSignal('SIGINT', async () => {
    deps.log('\nDisconnecting...');
    await shutdown();
    deps.exit(0);
  });

  deps.onSignal('SIGTERM', async () => {
    await shutdown();
    deps.exit(0);
  });

  await deps.holdOpen();
  await shutdown();
}
