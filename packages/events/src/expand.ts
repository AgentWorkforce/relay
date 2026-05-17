import type {
  EventSummary,
  Expansion,
  ExpansionOptionsForLevel,
  ExpansionLevel,
  ThreadExpansionOptions,
} from './types.js';
import { FeatureNotImplementedError } from './types.js';

interface CreateExpanderOptions {
  eventId: string;
  path: string;
  summary: EventSummary;
  cache?: Map<string, Promise<Expansion>>;
  loadFull?: () => Promise<Expansion<'full'>>;
  loadDiff?: () => Promise<Expansion<'diff'>>;
  loadThread?: (options?: ThreadExpansionOptions) => Promise<Expansion<'thread'>>;
}

/**
 * Creates the progressive-disclosure `expand()` function attached to an event.
 */
export function createExpander(options: CreateExpanderOptions) {
  const cache = options.cache ?? new Map<string, Promise<Expansion>>();

  return async function expand<L extends ExpansionLevel = 'full'>(
    level?: L,
    expansionOptions?: ExpansionOptionsForLevel<L>
  ): Promise<Expansion<L>> {
    const targetLevel = (level ?? 'full') as ExpansionLevel;
    const cacheKey = buildCacheKey(
      options.eventId,
      targetLevel,
      expansionOptions as ThreadExpansionOptions | undefined
    );

    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = materializeExpansion(
        targetLevel,
        options,
        expansionOptions as ThreadExpansionOptions | undefined
      ).catch((error) => {
        cache.delete(cacheKey);
        throw error;
      });
      cache.set(cacheKey, pending);
    }

    return pending as Promise<Expansion<L>>;
  };
}

async function materializeExpansion(
  level: ExpansionLevel,
  options: CreateExpanderOptions,
  expansionOptions?: ThreadExpansionOptions
): Promise<Expansion> {
  switch (level) {
    case 'summary':
      return {
        level: 'summary',
        path: options.path,
        summary: cloneSummary(options.summary),
      };
    case 'full':
      return await loadRequiredExpansion('full', options.path, options.loadFull);
    case 'diff':
      return await loadRequiredExpansion('diff', options.path, options.loadDiff);
    case 'thread':
      return await loadRequiredExpansion('thread', options.path, options.loadThread, expansionOptions);
    default: {
      const exhaustive: never = level;
      throw new Error(`Unsupported expansion level: ${String(exhaustive)}`);
    }
  }
}

function cloneSummary(summary: EventSummary): EventSummary {
  return {
    ...summary,
    labels: summary.labels ? [...summary.labels] : undefined,
    fieldsChanged: summary.fieldsChanged ? [...summary.fieldsChanged] : undefined,
    tags: summary.tags ? [...summary.tags] : undefined,
    actor: summary.actor ? { ...summary.actor } : undefined,
  };
}

function buildCacheKey(eventId: string, level: ExpansionLevel, options?: ThreadExpansionOptions): string {
  if (level !== 'thread') {
    return `${eventId}:${level}`;
  }

  return `${eventId}:${level}:${JSON.stringify({
    cursor: options?.cursor ?? null,
    limit: options?.limit ?? null,
  })}`;
}

async function loadRequiredExpansion<L extends 'full' | 'diff' | 'thread'>(
  level: L,
  path: string,
  loader:
    | (() => Promise<Expansion<L>>)
    | ((options?: ThreadExpansionOptions) => Promise<Expansion<L>>)
    | undefined,
  expansionOptions?: L extends 'thread' ? ThreadExpansionOptions : undefined
): Promise<Expansion<L>> {
  if (!loader) {
    if (level === 'diff' || level === 'thread') {
      throw new FeatureNotImplementedError(
        level === 'diff' ? 'M2_NOT_IMPLEMENTED' : 'M3_NOT_IMPLEMENTED',
        `expand("${level}") is unavailable for ${path} because no gateway loader was configured`
      );
    }
    throw new Error(`expand("${level}") is unavailable for ${path} because no gateway loader was configured`);
  }

  if (level === 'thread') {
    return await (loader as (options?: ThreadExpansionOptions) => Promise<Expansion<L>>)(expansionOptions);
  }

  return await (loader as () => Promise<Expansion<L>>)();
}
