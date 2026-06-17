import type {
  DeriveDescriptorsOptions,
  IntegrationDescriptor,
  MountDiscoveryReader,
  MountListPaths,
  MountReadFile,
  WritableResourceDescriptor,
} from './types.js';

const DEFAULT_DISCOVERY_ROOT = '.integrations/discovery';

const DEFAULT_KNOWN_PROVIDERS = [
  'github',
  'gitlab',
  'slack',
  'notion',
  'linear',
  'jira',
  'confluence',
  'gmail',
  'google-mail',
  'google-calendar',
  'hubspot',
  'granola',
  'fathom',
  'docker-hub',
  'recall',
];

type NormalizedOptions = Required<Pick<DeriveDescriptorsOptions, 'discoveryRoot' | 'knownProviders'>> & {
  listPaths?: MountListPaths;
};

export async function deriveDescriptorsFromMount(
  reader: MountDiscoveryReader | MountReadFile,
  options: DeriveDescriptorsOptions | string = {},
): Promise<IntegrationDescriptor[]> {
  const readFile = typeof reader === 'function' ? reader : reader.readFile;
  const normalized = normalizeOptions(reader, options);
  const providers = await discoverProviders(readFile, normalized);
  const descriptors: IntegrationDescriptor[] = [];

  for (const provider of providers) {
    const providerRoot = joinPath(normalized.discoveryRoot, provider);
    const adapterDoc = await readFileSafe(readFile, joinPath(providerRoot, '.adapter.md'));
    const resources = parseWritableResources(adapterDoc ?? '', provider);
    const discoveredResources = resources.length > 0
      ? resources
      : await discoverWritableResourcesFromTree(provider, providerRoot, normalized.listPaths);

    if (!adapterDoc && discoveredResources.length === 0) continue;

    descriptors.push({
      provider,
      mountRoot: `.integrations/${provider}`,
      discoveryRoot: providerRoot,
      writableResources: discoveredResources,
      description: adapterDoc ? firstParagraph(adapterDoc) : undefined,
    });
  }

  return descriptors.sort((a, b) => a.provider.localeCompare(b.provider));
}

export function parseWritableResources(adapterDoc: string, providerHint?: string): WritableResourceDescriptor[] {
  const rows = parseMarkdownResourceRows(adapterDoc);
  if (rows.length > 0) return rows;

  return parseWriteFieldContracts(adapterDoc, providerHint);
}

async function discoverProviders(readFile: MountReadFile, options: NormalizedOptions): Promise<string[]> {
  const providers = new Set<string>();
  const listed = await listProviderNames(options.discoveryRoot, options.listPaths);

  for (const provider of listed) providers.add(provider);

  const manifest = await readJsonSafe(readFile, joinPath(options.discoveryRoot, 'index.json'));
  for (const provider of providersFromManifest(manifest)) providers.add(provider);

  const adapterProviders = providers.size > 0 ? Array.from(providers) : options.knownProviders;
  for (const provider of adapterProviders) {
    if (providers.has(provider)) continue;
    const adapterDoc = await readFileSafe(readFile, joinPath(options.discoveryRoot, provider, '.adapter.md'));
    if (adapterDoc !== undefined) providers.add(provider);
  }

  return Array.from(providers).filter(Boolean).sort();
}

async function discoverWritableResourcesFromTree(
  provider: string,
  providerRoot: string,
  listPaths?: MountListPaths,
): Promise<WritableResourceDescriptor[]> {
  if (!listPaths) return [];
  const paths = await listPathsSafe(listPaths, providerRoot);
  const resources = new Map<string, WritableResourceDescriptor>();

  for (const path of paths) {
    const normalized = normalizePath(path);
    if (!normalized.endsWith('/.create.example.json')) continue;

    const discoveryRelative = stripPrefix(normalized, providerRoot);
    const resourceRelative = discoveryRelative.replace(/\/\.create\.example\.json$/u, '');
    const resourcePath = `/${provider}/${resourceRelative.replace(/^\/+/u, '')}`;
    resources.set(resourcePath, {
      path: resourcePath,
      createExamplePath: normalized,
      schemaPath: normalized.replace(/\/\.create\.example\.json$/u, '/.schema.json'),
      name: lastMeaningfulSegment(resourcePath),
    });
  }

  return Array.from(resources.values()).sort(compareResources);
}

function parseMarkdownResourceRows(adapterDoc: string): WritableResourceDescriptor[] {
  const resources = new Map<string, WritableResourceDescriptor>();

  for (const rawLine of adapterDoc.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+\s*\|/u.test(line)) continue;
    if (/^\|\s*Resource\s*\|/iu.test(line)) continue;

    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => stripCode(cell.trim()));

    if (cells.length < 3) continue;
    const [resourceCell, schemaCell, createExampleCell, , descriptionCell] = cells;
    if (!resourceCell || !resourceCell.startsWith('/')) continue;

    const path = resourceCell.replace(/\/<id>\.json$/u, '').replace(/\/\{id\}\.json$/u, '');
    resources.set(path, {
      path,
      schemaPath: schemaCell && schemaCell.startsWith('/') ? schemaCell : undefined,
      createExamplePath: createExampleCell && createExampleCell.startsWith('/') ? createExampleCell : undefined,
      description: descriptionCell || undefined,
      name: lastMeaningfulSegment(path),
    });
  }

  return Array.from(resources.values()).sort(compareResources);
}

function parseWriteFieldContracts(adapterDoc: string, providerHint?: string): WritableResourceDescriptor[] {
  const resources = new Map<string, WritableResourceDescriptor>();
  let pendingDescription: string | undefined;
  let currentPath: string | undefined;

  for (const rawLine of adapterDoc.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const heading = line.match(/^###\s+(.+)$/u);
    if (heading) {
      pendingDescription = heading[1]?.trim();
      currentPath = undefined;
      continue;
    }

    const resource = line.match(/^Resource:\s+`?([^`\s]+)`?/iu);
    if (resource) {
      currentPath = normalizeResourcePath(resource[1] ?? '');
      continue;
    }

    const createExample = line.match(/^Create example:\s+`?([^`\s]+)`?/iu);
    if (createExample && currentPath) {
      resources.set(currentPath, {
        path: currentPath,
        createExamplePath: createExample[1],
        description: pendingDescription,
        name: lastMeaningfulSegment(currentPath),
      });
    }
  }

  if (resources.size === 0 && providerHint) {
    const fallbackPattern = new RegExp(`/${escapeRegExp(providerHint)}/[^\\s\`|]+/\\.create\\.example\\.json`, 'gu');
    for (const match of adapterDoc.matchAll(fallbackPattern)) {
      const createExamplePath = match[0];
      const path = normalizeResourcePath(createExamplePath.replace(/\/\.create\.example\.json$/u, ''));
      resources.set(path, {
        path,
        createExamplePath,
        name: lastMeaningfulSegment(path),
      });
    }
  }

  return Array.from(resources.values()).sort(compareResources);
}

function normalizeOptions(
  reader: MountDiscoveryReader | MountReadFile,
  options: DeriveDescriptorsOptions | string,
): NormalizedOptions {
  const opts = typeof options === 'string' ? { discoveryRoot: options } : options;
  const readerList = typeof reader === 'function' ? undefined : reader.listPaths ?? reader.listTree;
  return {
    discoveryRoot: trimTrailingSlash(opts.discoveryRoot ?? DEFAULT_DISCOVERY_ROOT),
    knownProviders: opts.knownProviders ?? DEFAULT_KNOWN_PROVIDERS,
    listPaths: opts.listPaths ?? opts.listTree ?? readerList,
  };
}

async function listProviderNames(root: string, listPaths?: MountListPaths): Promise<string[]> {
  if (!listPaths) return [];
  const paths = await listPathsSafe(listPaths, root);
  const providers = new Set<string>();

  for (const path of paths) {
    const relative = stripPrefix(normalizePath(path), root);
    const provider = relative.split('/').filter(Boolean)[0];
    if (provider && !provider.startsWith('.')) providers.add(provider);
  }

  return Array.from(providers).sort();
}

function providersFromManifest(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      if (entry && typeof entry === 'object' && typeof (entry as { provider?: unknown }).provider === 'string') {
        return [(entry as { provider: string }).provider];
      }
      return [];
    });
  }

  if (value && typeof value === 'object') {
    const record = value as { providers?: unknown; integrations?: unknown };
    return [...providersFromManifest(record.providers), ...providersFromManifest(record.integrations)];
  }

  return [];
}

async function readJsonSafe(readFile: MountReadFile, path: string): Promise<unknown> {
  const content = await readFileSafe(readFile, path);
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function readFileSafe(readFile: MountReadFile, path: string): Promise<string | undefined> {
  try {
    const value = await readFile(path);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function listPathsSafe(listPaths: MountListPaths, path: string): Promise<string[]> {
  try {
    const value = await listPaths(path);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function firstParagraph(markdown: string): string | undefined {
  const lines = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return lines[0];
}

function normalizeResourcePath(path: string): string {
  return path.replace(/\/<id>\.json$/u, '').replace(/\/\{id\}\.json$/u, '');
}

function joinPath(...parts: string[]): string {
  return parts.map((part, index) => {
    const trimmed = index === 0 ? trimTrailingSlash(part) : part.replace(/^\/+|\/+$/gu, '');
    return trimmed;
  }).filter(Boolean).join('/');
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/\/$/u, '');
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/u, '');
}

function stripPrefix(path: string, prefix: string): string {
  const normalizedPrefix = normalizePath(prefix);
  const normalizedPath = normalizePath(path);
  if (normalizedPath === normalizedPrefix) return '';
  if (normalizedPath.startsWith(`${normalizedPrefix}/`)) return normalizedPath.slice(normalizedPrefix.length + 1);
  return normalizedPath;
}

function stripCode(value: string): string {
  return value.replace(/^`|`$/gu, '').trim();
}

function lastMeaningfulSegment(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean);
  return segments.at(-1)?.replace(/\.(json|md)$/u, '');
}

function compareResources(a: WritableResourceDescriptor, b: WritableResourceDescriptor): number {
  return a.path.localeCompare(b.path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
