import { Buffer } from 'node:buffer';

import type {
  AttributeOutput,
  AttributeParams,
  BrowserActionContext,
  ElementSelector,
  HtmlOutput,
  HtmlParams,
  ScreenshotOutput,
  ScreenshotParams,
  TextOutput,
  TextParams,
} from '../types.js';

function selectorLabel(selector: ElementSelector): string {
  return typeof selector === 'string' ? selector : selector.selector;
}

export async function text(context: BrowserActionContext, params: TextParams = {}): Promise<TextOutput> {
  const selector = params.selector ?? 'body';
  const locator = await context.waitForElement(selector, {
    state: 'attached',
    timeout: params.timeout,
  });

  if (params.all) {
    const values = params.innerText ? await locator.allInnerTexts() : await locator.allTextContents();

    return {
      selector: params.selector ? selectorLabel(params.selector) : undefined,
      text: values,
    };
  }

  const value = params.innerText
    ? await locator.innerText({
        timeout: params.timeout ?? context.config.timeout,
      })
    : await locator.textContent({
        timeout: params.timeout ?? context.config.timeout,
      });

  return {
    selector: params.selector ? selectorLabel(params.selector) : undefined,
    text: value,
  };
}

export async function html(context: BrowserActionContext, params: HtmlParams = {}): Promise<HtmlOutput> {
  if (!params.selector) {
    return {
      html: await context.page.content(),
    };
  }

  const locator = await context.waitForElement(params.selector, {
    state: 'attached',
    timeout: params.timeout,
  });
  const value = await locator.evaluate((element, outerHTML) => {
    return outerHTML ? element.outerHTML : element.innerHTML;
  }, params.outerHTML ?? false);

  return {
    selector: selectorLabel(params.selector),
    html: value,
  };
}

export async function attribute(
  context: BrowserActionContext,
  params: AttributeParams
): Promise<AttributeOutput> {
  const locator = await context.waitForElement(params.selector, {
    state: 'attached',
    timeout: params.timeout,
  });

  return {
    selector: selectorLabel(params.selector),
    name: params.name,
    value: await locator.getAttribute(params.name, {
      timeout: params.timeout ?? context.config.timeout,
    }),
  };
}

export async function screenshot(
  context: BrowserActionContext,
  params: ScreenshotParams = {}
): Promise<ScreenshotOutput> {
  const type = params.type ?? 'png';
  const common = {
    path: params.path,
    type,
    quality: type === 'jpeg' ? params.quality : undefined,
    timeout: params.timeout ?? context.config.timeout,
    omitBackground: params.omitBackground,
    animations: params.animations,
    scale: params.scale,
  };

  const buffer = params.selector
    ? await (
        await context.waitForElement(params.selector, {
          state: 'visible',
          timeout: params.timeout,
        })
      ).screenshot(common)
    : await context.page.screenshot({
        ...common,
        fullPage: params.fullPage,
      });

  const bytes = Buffer.byteLength(buffer);

  return {
    path: params.path,
    base64: params.path ? undefined : buffer.toString('base64'),
    bytes,
    type,
    fullPage: params.fullPage,
    selector: params.selector ? selectorLabel(params.selector) : undefined,
  };
}
