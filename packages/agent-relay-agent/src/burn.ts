import { AsyncLocalStorage } from 'node:async_hooks';

export interface BurnTags {
  workspace: string;
  agentId: string;
  eventType: string;
  eventId: string;
  occurredAt: string;
}

const storage = new AsyncLocalStorage<BurnTags | null>();

const BURN_SOURCE_HEADER = 'x-relayburn-source';
const BURN_TAG_HEADERS = {
  workspace: 'x-relayburn-tag-workspace',
  agentId: 'x-relayburn-tag-agent-id',
  eventType: 'x-relayburn-tag-event-type',
  eventId: 'x-relayburn-tag-event-id',
  occurredAt: 'x-relayburn-tag-occurred-at',
} as const;
const TRUSTED_PROVIDER_HOSTS = new Set(['api.openai.com', 'api.anthropic.com']);

const FETCH_WRAPPED = Symbol.for('@agent-relay/agent/burn-fetch-wrapped');
const CLIENT_WRAPPED = Symbol.for('@agent-relay/agent/burn-client-wrapped');

type FetchLike = typeof globalThis.fetch;

type MaybeWrappedFetch = FetchLike & {
  [FETCH_WRAPPED]?: true;
};

type MaybeWrappedClient = Record<PropertyKey, unknown> & {
  [CLIENT_WRAPPED]?: true;
};

export async function withBurnTags<T>(tags: BurnTags, fn: () => Promise<T>): Promise<T> {
  ensureGlobalFetchWrapped();
  return await storage.run(tags, fn);
}

export function tagWithCurrentBurnTags<T>(value: T): T {
  const tags = storage.getStore();
  return tags ? tagValue(value, tags) : value;
}

function ensureGlobalFetchWrapped(): void {
  if (typeof globalThis.fetch !== 'function') {
    return;
  }

  const currentFetch = globalThis.fetch as MaybeWrappedFetch;
  if (currentFetch[FETCH_WRAPPED]) {
    return;
  }

  const original = currentFetch.bind(globalThis);
  const wrapped = createTaggedFetch(original, () => storage.getStore() ?? null);
  globalThis.fetch = wrapped;
}

function createTaggedFetch(fetchImpl: FetchLike, getTags: () => BurnTags | null): FetchLike {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const tags = getTags();
    if (!tags) {
      return await fetchImpl(input, init);
    }

    const request = new Request(input, init);
    if (!shouldTagRequest(request)) {
      return await fetchImpl(request);
    }

    const headers = new Headers(request.headers);
    headers.set(BURN_SOURCE_HEADER, 'agent-relay');
    headers.set(BURN_TAG_HEADERS.workspace, tags.workspace);
    headers.set(BURN_TAG_HEADERS.agentId, tags.agentId);
    headers.set(BURN_TAG_HEADERS.eventType, tags.eventType);
    headers.set(BURN_TAG_HEADERS.eventId, tags.eventId);
    headers.set(BURN_TAG_HEADERS.occurredAt, tags.occurredAt);

    return await fetchImpl(new Request(request, { headers }));
  }) as MaybeWrappedFetch;

  wrapped[FETCH_WRAPPED] = true;
  return wrapped;
}

function shouldTagRequest(request: Request): boolean {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (TRUSTED_PROVIDER_HOSTS.has(host)) {
    return true;
  }

  const headers = request.headers;
  if (
    headers.has('anthropic-version') ||
    headers.has('openai-beta') ||
    headers.has('x-stainless-lang') ||
    headers.has('x-stainless-package-version')
  ) {
    return true;
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';
  return (
    TRUSTED_PROVIDER_HOSTS.has(host) &&
    (path === '/v1/chat/completions' ||
      path === '/v1/responses' ||
      path === '/v1/completions' ||
      path === '/v1/embeddings' ||
      path === '/v1/messages' ||
      path === '/v1/messages/count_tokens' ||
      path === '/v1/complete')
  );
}

function tagValue<T>(value: T, tags: BurnTags): T {
  if (typeof value === 'function') {
    return createTaggedFetch(value as FetchLike, () => tags) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const client = value as MaybeWrappedClient;
  if (client[CLIENT_WRAPPED]) {
    return value;
  }

  if (patchFetchProperty(client, 'fetch', tags)) {
    client[CLIENT_WRAPPED] = true;
    return value;
  }
  if (patchOptionsFetch(client, '_options', tags)) {
    client[CLIENT_WRAPPED] = true;
    return value;
  }
  if (patchOptionsFetch(client, 'options', tags)) {
    client[CLIENT_WRAPPED] = true;
    return value;
  }
  if (patchNestedClient(client, '_client', tags)) {
    client[CLIENT_WRAPPED] = true;
    return value;
  }

  return value;
}

function patchNestedClient(target: MaybeWrappedClient, key: string, tags: BurnTags): boolean {
  const nested = target[key];
  if (!nested || typeof nested !== 'object') {
    return false;
  }

  const nestedClient = nested as MaybeWrappedClient;
  return (
    patchFetchProperty(nestedClient, 'fetch', tags) ||
    patchOptionsFetch(nestedClient, '_options', tags) ||
    patchOptionsFetch(nestedClient, 'options', tags)
  );
}

function patchOptionsFetch(target: MaybeWrappedClient, key: string, tags: BurnTags): boolean {
  const options = target[key];
  if (!options || typeof options !== 'object') {
    return false;
  }

  const record = options as Record<string, unknown>;
  const existing = typeof record.fetch === 'function' ? (record.fetch as FetchLike) : globalThis.fetch;
  if (typeof existing !== 'function') {
    return false;
  }

  record.fetch = createTaggedFetch(existing, () => tags);
  return true;
}

function patchFetchProperty(target: MaybeWrappedClient, key: string, tags: BurnTags): boolean {
  const existing = target[key];
  if (typeof existing !== 'function') {
    return false;
  }

  target[key] = createTaggedFetch(existing.bind(target) as FetchLike, () => tags) as unknown;
  return true;
}
