import type {
  IntegrationDescriptor,
  IntegrationSubscriptionSummary,
  WritableResourceDescriptor,
} from './types.js';

export function prescriptiveInstructions(descriptors: IntegrationDescriptor[]): string {
  const integrations = normalizeDescriptors(descriptors);
  if (integrations.length === 0) return '';

  const lines = [
    '## Integration writebacks',
    'To dispatch an integration action, write a JSON file under the resource path -- do NOT use relay messaging for these actions.',
    'Read the sibling .schema.json and .create.example.json files under .integrations/discovery/<provider>/ before writing.',
    'Do not create provider records inside discovery; discovery is schema-only.',
    '',
    'Available writeback resources:',
  ];

  for (const descriptor of integrations) {
    lines.push(`- ${labelFor(descriptor)} (${descriptor.mountRoot})`);
    for (const resource of descriptor.writableResources) {
      lines.push(`  - ${resourceLine(descriptor, resource)}`);
    }
  }

  return lines.join('\n');
}

export function fullInjectInstructions(descriptors: IntegrationDescriptor[]): string {
  const integrations = normalizeDescriptors(descriptors);
  const lines = [
    '<integrations-update>',
    'The user has connected the following integrations to this project:',
  ];

  if (integrations.length === 0) {
    lines.push('- none');
  } else {
    for (const descriptor of integrations) {
      lines.push(fullDescriptorLine(descriptor));
    }
  }

  const subscriptions = integrations.flatMap((descriptor) =>
    (descriptor.subscriptions ?? []).map((subscription) => ({
      provider: subscription.provider ?? descriptor.provider,
      watches: subscription.watches,
      targets: subscription.targets ?? [],
    }))
  );

  lines.push('');
  if (subscriptions.length === 0) {
    lines.push('No integration event subscriptions are active for this project.');
  } else {
    lines.push('Active integration event subscriptions for this project:');
    for (const subscription of subscriptions) {
      lines.push(subscriptionLine(subscription));
    }
    lines.push(
      'You will receive <integration-event> system messages for these subscribed changes. Do not poll these integrations for background changes; wait for the event notification, then read the mounted files for context if needed.'
    );
  }

  lines.push(
    'Writeback discovery schemas and examples are mounted through .integrations/discovery/<provider>/ for connected integrations. Use those schemas to create files under the provider paths such as .integrations/slack/channels/<channelId>/messages; do not create provider records inside discovery. Historical provider records are only intentionally downloaded when historical download is enabled. Incoming webhook events do not require downloading history.',
    '</integrations-update>'
  );

  return lines.join('\n');
}

export function initialSpawnInstructions(descriptors: IntegrationDescriptor[]): string {
  const snippet = fullInjectInstructions(descriptors);
  if (!snippet) return '';
  return [
    'Initial project integration context. Treat this as setup context, not as the user task.',
    snippet,
  ].join('\n');
}

export function slimInstructions(descriptors: IntegrationDescriptor[]): string {
  const integrations = normalizeDescriptors(descriptors);
  if (integrations.length === 0) return '';

  const names = integrations.map((descriptor) => {
    const resources = descriptor.writableResources.map((resource) => resource.path).join(', ');
    return resources ? `${descriptor.provider}: ${resources}` : descriptor.provider;
  });

  return [
    `Connected integrations: ${names.join('; ')}.`,
    'For integration actions, write JSON under the provider resource path in .integrations; do NOT use relay messaging. Discovery schemas and examples are under .integrations/discovery/<provider>/.',
  ].join('\n');
}

function fullDescriptorLine(descriptor: IntegrationDescriptor): string {
  const scopeSummary =
    descriptor.scopeLabels && descriptor.scopeLabels.length > 0
      ? descriptor.scopeLabels.join(', ')
      : 'all configured scope';
  const eventScopes =
    descriptor.eventScopePaths && descriptor.eventScopePaths.length > 0
      ? ` (event scope ${descriptor.eventScopePaths.join(', ')})`
      : ' (no event scope configured)';
  const discoveryRoot = descriptor.discoveryRoot ?? `.integrations/discovery/${descriptor.provider}`;
  const writebackPaths =
    descriptor.writebackPaths && descriptor.writebackPaths.length > 0
      ? descriptor.writebackPaths
      : descriptor.writableResources.map((resource) => resource.path);
  const writebackInstruction =
    writebackPaths.length > 0
      ? `create writeback files under ${writebackPaths.join(', ')}, not under discovery`
      : 'select narrower resources before creating local writeback files; discovery is schema-only';
  const historyClause = historyText(descriptor, writebackPaths);

  return `- ${descriptor.provider}: ${scopeSummary}${eventScopes}. Writeback schemas and examples are available at ${discoveryRoot}; ${writebackInstruction}. ${historyClause}`;
}

function historyText(descriptor: IntegrationDescriptor, writebackPaths: string[]): string {
  const skipped = descriptor.skippedLocalPaths ?? [];
  if (descriptor.downloadHistoricalData === true) {
    if (skipped.length > 0) {
      return `Historical download is enabled, but these provider paths are not locally poll-mounted: ${skipped.join(', ')}. Select fewer or narrower resources to download local history.`;
    }
    return `Historical provider records are available at ${writebackPaths.join(', ') || 'the configured provider paths'}.`;
  }

  if (writebackPaths.length === 0) {
    return 'Local historical provider records are not downloaded. No narrow writeback command roots are mounted; select narrower resources to enable local writeback transport.';
  }

  const liveContext =
    descriptor.liveContextPaths && descriptor.liveContextPaths.length > 0
      ? `, and live thread context roots are mounted at ${descriptor.liveContextPaths.join(', ')}`
      : '';
  return `Local historical provider records are not broadly downloaded. Writeback command roots are mounted at ${writebackPaths.join(', ')}${liveContext}; provider context should be read on demand or through incoming events.`;
}

function subscriptionLine(subscription: Required<IntegrationSubscriptionSummary>): string {
  const parts = [
    subscription.watches.length > 0 ? `file changes at ${subscription.watches.join(', ')}` : '',
    subscription.targets.length > 0
      ? `delivered to ${subscription.targets.join(', ')}`
      : 'delivered to all project agents',
  ].filter(Boolean);
  return `- ${subscription.provider}: ${parts.join('; ')}`;
}

function resourceLine(descriptor: IntegrationDescriptor, resource: WritableResourceDescriptor): string {
  const parts = [resource.path];
  if (resource.createExamplePath) parts.push(`create example ${resource.createExamplePath}`);
  if (resource.schemaPath) parts.push(`schema ${resource.schemaPath}`);
  if (resource.description) parts.push(resource.description.replace(/\.$/u, ''));
  if (parts.length === 1) {
    parts.push(`write JSON drafts under ${resource.path}`);
  }
  const concreteHint = resource.path.startsWith(descriptor.mountRoot)
    ? ''
    : ` (mounted under ${descriptor.mountRoot})`;
  return `${parts.join(' -- ')}${concreteHint}`;
}

function normalizeDescriptors(descriptors: IntegrationDescriptor[]): IntegrationDescriptor[] {
  return descriptors
    .filter((descriptor) => descriptor.provider.trim())
    .map((descriptor) => ({
      ...descriptor,
      provider: descriptor.provider.trim(),
      mountRoot: descriptor.mountRoot || `.integrations/${descriptor.provider.trim()}`,
      writableResources: [...descriptor.writableResources].sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function labelFor(descriptor: IntegrationDescriptor): string {
  return descriptor.displayName ? `${descriptor.displayName} / ${descriptor.provider}` : descriptor.provider;
}
