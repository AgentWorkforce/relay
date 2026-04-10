import type {
  BrowserActionContext,
  CheckParams,
  ClickParams,
  ElementSelector,
  FillParams,
  HoverParams,
  PressParams,
  SelectParams,
  SelectorActionOutput,
  SubmitParams,
  UploadParams,
  WaitForSelectorOptions,
} from '../types.js';

function selectorLabel(selector: ElementSelector): string {
  return typeof selector === 'string' ? selector : selector.selector;
}

function waitOptions(
  waitFor: boolean | WaitForSelectorOptions | undefined,
  timeout: number | undefined
): WaitForSelectorOptions | undefined {
  if (waitFor === false) {
    return undefined;
  }

  if (typeof waitFor === 'object') {
    return {
      timeout,
      ...waitFor,
    };
  }

  return { state: 'visible', timeout };
}

async function locatorForInteraction(
  context: BrowserActionContext,
  selector: ElementSelector,
  waitFor: boolean | WaitForSelectorOptions | undefined,
  timeout: number | undefined
) {
  const options = waitOptions(waitFor, timeout);
  if (options) {
    return context.waitForElement(selector, options);
  }

  return context.resolveLocator(selector);
}

export async function click(
  context: BrowserActionContext,
  params: ClickParams
): Promise<SelectorActionOutput> {
  const locator = await locatorForInteraction(
    context,
    params.selector,
    params.waitFor ?? true,
    params.timeout
  );

  await locator.click({
    button: params.button,
    clickCount: params.clickCount,
    delay: params.delay,
    timeout: params.timeout ?? context.config.timeout,
    force: params.force,
    noWaitAfter: params.noWaitAfter,
    position: params.position,
    modifiers: params.modifiers,
    trial: params.trial,
  });

  return {
    selector: selectorLabel(params.selector),
    action: 'click',
  };
}

export async function fill(context: BrowserActionContext, params: FillParams): Promise<SelectorActionOutput> {
  const locator = await locatorForInteraction(
    context,
    params.selector,
    params.waitFor ?? true,
    params.timeout
  );

  if (params.clear === false) {
    await locator.pressSequentially(params.value, {
      delay: 0,
      timeout: params.timeout ?? context.config.timeout,
    });
  } else {
    await locator.fill(params.value, {
      timeout: params.timeout ?? context.config.timeout,
      force: params.force,
    });
  }

  return {
    selector: selectorLabel(params.selector),
    action: 'fill',
  };
}

export async function check(
  context: BrowserActionContext,
  params: CheckParams
): Promise<SelectorActionOutput> {
  const locator = await locatorForInteraction(
    context,
    params.selector,
    params.waitFor ?? true,
    params.timeout
  );
  const checked = params.checked ?? true;

  await locator.setChecked(checked, {
    timeout: params.timeout ?? context.config.timeout,
    force: params.force,
    noWaitAfter: params.noWaitAfter,
    trial: params.trial,
  });

  return {
    selector: selectorLabel(params.selector),
    action: checked ? 'check' : 'uncheck',
  };
}

export async function uncheck(
  context: BrowserActionContext,
  params: Omit<CheckParams, 'checked'>
): Promise<SelectorActionOutput> {
  return check(context, {
    ...params,
    checked: false,
  });
}

export async function select(
  context: BrowserActionContext,
  params: SelectParams
): Promise<SelectorActionOutput & { values: string[] }> {
  const locator = await locatorForInteraction(
    context,
    params.selector,
    params.waitFor ?? true,
    params.timeout
  );
  const values = Array.isArray(params.values) ? params.values : [params.values];

  await locator.selectOption(values, {
    timeout: params.timeout ?? context.config.timeout,
    force: params.force,
  });

  return {
    selector: selectorLabel(params.selector),
    action: 'select',
    values,
  };
}

export async function hover(
  context: BrowserActionContext,
  params: HoverParams
): Promise<SelectorActionOutput> {
  const locator = await locatorForInteraction(
    context,
    params.selector,
    params.waitFor ?? true,
    params.timeout
  );

  await locator.hover({
    timeout: params.timeout ?? context.config.timeout,
    force: params.force,
    position: params.position,
    modifiers: params.modifiers,
    trial: params.trial,
  });

  return {
    selector: selectorLabel(params.selector),
    action: 'hover',
  };
}

export async function press(
  context: BrowserActionContext,
  params: PressParams
): Promise<SelectorActionOutput & { key: string }> {
  const locator = await locatorForInteraction(
    context,
    params.selector,
    params.waitFor ?? true,
    params.timeout
  );

  await locator.press(params.key, {
    timeout: params.timeout ?? context.config.timeout,
    delay: params.delay,
    noWaitAfter: params.noWaitAfter,
  });

  return {
    selector: selectorLabel(params.selector),
    action: 'press',
    key: params.key,
  };
}

export async function submit(
  context: BrowserActionContext,
  params: SubmitParams = {}
): Promise<SelectorActionOutput> {
  const selector = params.selector ?? 'form';
  const locator = await locatorForInteraction(context, selector, true, params.timeout);

  const submitAction = locator.evaluate((element) => {
    const form = element.tagName.toLowerCase() === 'form' ? element : element.closest('form');

    if (!form) {
      throw new Error('No form found for submit action');
    }

    (form as HTMLFormElement).requestSubmit();
  });

  if (params.waitForNavigation) {
    await Promise.all([
      context.page.waitForNavigation({
        waitUntil: params.waitUntil ?? 'load',
        timeout: params.timeout ?? context.config.timeout,
      }),
      submitAction,
    ]);
  } else {
    await submitAction;
  }

  return {
    selector: selectorLabel(selector),
    action: 'submit',
  };
}

export async function upload(
  context: BrowserActionContext,
  params: UploadParams
): Promise<SelectorActionOutput & { files: string[] }> {
  const locator = await locatorForInteraction(
    context,
    params.selector,
    params.waitFor ?? true,
    params.timeout
  );
  const files = Array.isArray(params.filePath) ? params.filePath : [params.filePath];

  await locator.setInputFiles(files, {
    timeout: params.timeout ?? context.config.timeout,
  });

  return {
    selector: selectorLabel(params.selector),
    action: 'upload',
    files,
  };
}
