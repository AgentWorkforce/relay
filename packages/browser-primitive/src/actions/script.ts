import type { BrowserActionContext, ElementSelector, EvaluateParams } from '../types.js';

function selectorLabel(selector: ElementSelector): string {
  return typeof selector === 'string' ? selector : selector.selector;
}

export async function evaluate(context: BrowserActionContext, params: EvaluateParams): Promise<unknown> {
  if (params.selector) {
    const locator = await context.waitForElement(params.selector, {
      state: 'attached',
      timeout: params.timeout,
    });

    return locator.evaluate(
      (element, payload) => {
        const evaluated = eval(payload.script) as unknown;

        if (typeof evaluated === 'function') {
          return (evaluated as (...values: unknown[]) => unknown)(element, ...payload.args);
        }

        return evaluated;
      },
      {
        script: params.script,
        args: params.args ?? [],
        selector: selectorLabel(params.selector),
      },
      {
        timeout: params.timeout ?? context.config.timeout,
      }
    );
  }

  return context.page.evaluate(
    (payload) => {
      const evaluated = eval(payload.script) as unknown;

      if (typeof evaluated === 'function') {
        return (evaluated as (...values: unknown[]) => unknown)(...payload.args);
      }

      return evaluated;
    },
    {
      script: params.script,
      args: params.args ?? [],
    }
  );
}
