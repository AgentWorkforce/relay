import type {
  BrowserActionContext,
  WaitForFunctionParams,
  WaitForNavigationParams,
  WaitForSelectorParams,
  WaitOutput,
} from '../types.js';

function selectorLabel(selector: WaitForSelectorParams['selector']): string {
  return typeof selector === 'string' ? selector : selector.selector;
}

export async function waitForSelector(
  context: BrowserActionContext,
  params: WaitForSelectorParams
): Promise<WaitOutput> {
  await context.waitForElement(params.selector, {
    state: params.state ?? 'visible',
    timeout: params.timeout,
  });

  return {
    url: context.page.url(),
    selector: selectorLabel(params.selector),
    state: params.state ?? 'visible',
  };
}

export async function waitForNavigation(
  context: BrowserActionContext,
  params: WaitForNavigationParams = {}
): Promise<WaitOutput> {
  const timeout = params.timeout ?? context.config.timeout;
  const loadState = params.waitUntil === 'commit' ? 'load' : (params.waitUntil ?? 'load');

  if (params.url) {
    await context.page.waitForURL(params.url, {
      waitUntil: params.waitUntil ?? 'load',
      timeout,
    });
  } else {
    await context.page.waitForLoadState(loadState, {
      timeout,
    });
  }

  return {
    url: context.page.url(),
  };
}

export async function waitForFunction(
  context: BrowserActionContext,
  params: WaitForFunctionParams
): Promise<WaitOutput> {
  const handle = await context.page.waitForFunction(
    ({ args, script }) => {
      const evaluated = eval(script) as unknown;

      if (typeof evaluated === 'function') {
        return (evaluated as (...values: unknown[]) => unknown)(...args);
      }

      return evaluated;
    },
    {
      script: params.script,
      args: params.args ?? [],
    },
    {
      timeout: params.timeout ?? context.config.timeout,
      polling: params.polling,
    }
  );

  return {
    url: context.page.url(),
    value: await handle.jsonValue(),
  };
}
