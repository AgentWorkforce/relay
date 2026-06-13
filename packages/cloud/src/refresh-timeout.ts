import { CloudAuthError, DEFAULT_REFRESH_TIMEOUT_MS } from './types.js';

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError' || /aborted/i.test(error.message))
  );
}

function addAbortListener(signal: AbortSignal, listener: () => void): () => void {
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

export async function fetchWithRefreshTimeout(
  url: URL,
  init: RequestInit,
  options: { refreshTimeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Response> {
  const refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  let timedOut = false;
  let callerAborted = false;

  const abortFromCaller = () => {
    callerAborted = true;
    controller.abort();
  };

  for (const signal of [options.signal, init.signal]) {
    if (!signal) {
      continue;
    }

    if (signal.aborted) {
      callerAborted = true;
      controller.abort();
      break;
    }

    removers.push(addAbortListener(signal, abortFromCaller));
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, refreshTimeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut || (!callerAborted && isAbortLikeError(error))) {
      throw new CloudAuthError(
        'AUTH_REFRESH_TIMEOUT',
        `Cloud auth refresh timed out after ${refreshTimeoutMs}ms`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    for (const remove of removers) {
      remove();
    }
  }
}
