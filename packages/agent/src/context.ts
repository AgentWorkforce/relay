import { createLogger, type AgentEvent } from '@agent-relay/events';
import type {
  AgentPolicy,
  Context,
  FileSummary,
  LogFields,
  Logger,
  PostOpts,
  RelaycastClient,
  RelaycronClient,
  RelaycronScheduleDefinition,
  RelayfileClient,
  WorkspaceFile,
  WriteMeta,
} from './types.js';
import { tagWithCurrentBurnTags } from './burn.js';
import { createPolicyGate } from './policy.js';

interface CreateContextFactoryOptions {
  workspace: string;
  agentId: string;
  logger?: Logger;
  getRelayfileClient?: () => RelayfileClient | null | undefined;
  getRelaycastClient?: () => RelaycastClient | null | undefined;
  getRelaycronClient?: () => RelaycronClient | null | undefined;
  getOnceCoordinator?: () =>
    | {
        acquireOnce(key: string): Promise<boolean>;
        releaseOnce(key: string): Promise<void>;
      }
    | null
    | undefined;
  awaitApproval?: (approvalId: string) => Promise<unknown>;
  policy?: AgentPolicy;
  trackSchedule(id: string): void;
}

interface ContextFactory {
  base: Context;
  withEvent(signal: AbortSignal, event: AgentEvent): Context;
  withSignal(signal: AbortSignal): Context;
}

/**
 * Creates the shared base context plus per-dispatch signal overlays.
 */
export function createContextFactory(options: CreateContextFactoryOptions): ContextFactory {
  const logger =
    options.logger ??
    createLogger({
      workspace: options.workspace,
      agentId: options.agentId,
      level: 'debug',
    });
  const onceCache = new Map<string, Promise<unknown>>();
  const relayfile = createRelayfileClientProxy(options.getRelayfileClient);
  const relaycast = createRelaycastClientProxy(options.getRelaycastClient);
  const idleController = new AbortController();
  const policy = createPolicyGate({
    workspace: options.workspace,
    agentId: options.agentId,
    policy: options.policy,
    relayfile,
    awaitApproval: options.awaitApproval,
  });

  const build = (signal: AbortSignal, event?: AgentEvent): Context => ({
    get raw() {
      const relaycron = createRelaycronClientProxy(options.getRelaycronClient, options.trackSchedule);
      return {
        relayfile,
        relaycron,
        relaycast,
      };
    },
    workspace: options.workspace,
    agentId: options.agentId,
    logger: event
      ? bindContextLogger(logger, {
          eventId: event.id,
          eventType: event.type,
        })
      : logger,
    signal,
    tagged: (value) => tagWithCurrentBurnTags(value),
    files: {
      read: (path) => relayfile.read(path),
      write: (path, body, meta) =>
        policy.run('write', { path, body, ...(meta ? { meta } : {}) }, () =>
          relayfile.write(path, body, meta)
        ),
      delete: (path) => policy.run('delete', { path }, () => relayfile.delete(path)),
      list: (glob) => relayfile.list(glob),
    },
    messages: {
      post: (channel, text, postOptions) =>
        policy.run(
          'external-message',
          { method: 'post', channel, text, ...(postOptions ? { opts: postOptions } : {}) },
          () => relaycast.post(channel, text, postOptions)
        ),
      reply: (threadId, text, postOptions) =>
        policy.run(
          'external-message',
          { method: 'reply', threadId, text, ...(postOptions ? { opts: postOptions } : {}) },
          () => relaycast.reply(threadId, text, postOptions)
        ),
      dm: (agentOrUser, text, postOptions) =>
        policy.run(
          'external-message',
          { method: 'dm', agentOrUser, text, ...(postOptions ? { opts: postOptions } : {}) },
          () => relaycast.dm(agentOrUser, text, postOptions)
        ),
    },
    schedule: {
      at: async (when, payload) =>
        policy.run('schedule', { method: 'at', when, ...(payload === undefined ? {} : { payload }) }, () =>
          createRelaycronClientProxy(options.getRelaycronClient, options.trackSchedule).register({
            at: when,
            payload,
          })
        ) as Promise<{ id: string }>,
      every: async (cron, payload, scheduleOptions) =>
        policy.run(
          'schedule',
          {
            method: 'every',
            cron,
            ...(payload === undefined ? {} : { payload }),
            ...(scheduleOptions?.tz ? { tz: scheduleOptions.tz } : {}),
          },
          () =>
            createRelaycronClientProxy(options.getRelaycronClient, options.trackSchedule).register({
              cron,
              payload,
              tz: scheduleOptions?.tz,
            })
        ) as Promise<{ id: string }>,
      cancel: async (id) =>
        policy.run('schedule', { method: 'cancel', id }, () =>
          createRelaycronClientProxy(options.getRelaycronClient, options.trackSchedule).cancel(id)
        ) as Promise<void>,
    },
    // Returns `T` on the first caller that wins the dedup lock and `undefined`
    // on any caller that loses it (another agent or replicated instance has
    // already executed `fn` for this key). Callers must handle the
    // `undefined` branch — typically by treating it as "someone else did it,
    // skip this work".
    once: async <T>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
      const existing = onceCache.get(key) as Promise<T | undefined> | undefined;
      if (existing) {
        return existing;
      }

      const onceCoordinator = options.getOnceCoordinator?.();
      const pending = (async (): Promise<T | undefined> => {
        if (onceCoordinator) {
          const acquired = await onceCoordinator.acquireOnce(key);
          if (!acquired) {
            return undefined;
          }
        }
        try {
          return await fn();
        } catch (error) {
          if (onceCoordinator) {
            await onceCoordinator.releaseOnce(key);
          }
          onceCache.delete(key);
          throw error;
        }
      })();

      onceCache.set(key, pending);
      return pending;
    },
  });

  return {
    base: build(idleController.signal),
    withEvent: (signal, event) => build(signal, event),
    withSignal: (signal) => build(signal),
  };
}

function createRelayfileClientProxy(
  getClient: (() => RelayfileClient | null | undefined) | undefined
): RelayfileClient {
  const resolveClient = (): RelayfileClient => {
    const relayfile = getClient?.();
    if (!relayfile) {
      throw new Error('relayfile control plane is not ready yet');
    }
    return relayfile;
  };

  return {
    get available() {
      return getClient?.()?.available ?? false;
    },
    read: async (path: string): Promise<WorkspaceFile | null> => resolveClient().read(path),
    write: async (path: string, body: unknown, meta?: WriteMeta): Promise<void> =>
      resolveClient().write(path, body, meta),
    delete: async (path: string): Promise<void> => resolveClient().delete(path),
    list: async (glob: string): Promise<FileSummary[]> => resolveClient().list(glob),
  };
}

function createRelaycastClientProxy(
  getClient: (() => RelaycastClient | null | undefined) | undefined
): RelaycastClient {
  const resolveClient = (): RelaycastClient => {
    const relaycast = getClient?.();
    if (!relaycast) {
      throw new Error('relaycast control plane is not ready yet');
    }
    return relaycast;
  };

  return {
    get available() {
      return getClient?.()?.available ?? false;
    },
    post: async (channel: string, text: string, opts?: PostOpts): Promise<{ id: string }> =>
      resolveClient().post(channel, text, opts),
    reply: async (threadId: string, text: string, opts?: PostOpts): Promise<{ id: string }> =>
      resolveClient().reply(threadId, text, opts),
    dm: async (agentOrUser: string, text: string, opts?: PostOpts): Promise<{ id: string }> =>
      resolveClient().dm(agentOrUser, text, opts),
  };
}

function createRelaycronClientProxy(
  getClient: (() => RelaycronClient | null | undefined) | undefined,
  trackSchedule: (id: string) => void
): RelaycronClient {
  const resolveClient = (): RelaycronClient => {
    const relaycron = getClient?.();
    if (!relaycron) {
      throw new Error('relaycron control plane is not ready yet');
    }
    return relaycron;
  };

  return {
    get available() {
      return getClient?.()?.available ?? false;
    },
    register: async (definition: RelaycronScheduleDefinition) => {
      const result = await resolveClient().register(definition);
      trackSchedule(result.id);
      return result;
    },
    cancel: async (id) => resolveClient().cancel(id),
  };
}

function bindContextLogger(logger: Logger, fields: LogFields): Logger {
  const merge = (extra?: LogFields): LogFields => (extra ? { ...fields, ...extra } : { ...fields });

  return {
    debug: (message: string, extra?: LogFields) => logger.debug(message, merge(extra)),
    info: (message: string, extra?: LogFields) => logger.info(message, merge(extra)),
    warn: (message: string, extra?: LogFields) => logger.warn(message, merge(extra)),
    error: (message: string, extra?: LogFields) => logger.error(message, merge(extra)),
  };
}
