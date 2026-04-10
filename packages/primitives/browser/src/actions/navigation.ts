import type {
  BrowserActionContext,
  GotoParams,
  HistoryNavigationParams,
  NavigationOutput,
  ReloadParams,
} from '../types.js';

function responseOutput(
  context: BrowserActionContext,
  response: Awaited<ReturnType<BrowserActionContext['page']['goto']>>
): NavigationOutput {
  return {
    url: context.page.url(),
    status: response?.status() ?? null,
    ok: response?.ok() ?? null,
  };
}

export async function goto(context: BrowserActionContext, params: GotoParams): Promise<NavigationOutput> {
  const response = await context.page.goto(params.url, {
    waitUntil: params.waitUntil ?? 'load',
    timeout: params.timeout ?? context.config.timeout,
    referer: params.referer,
  });

  return responseOutput(context, response);
}

export async function back(
  context: BrowserActionContext,
  params: HistoryNavigationParams = {}
): Promise<NavigationOutput | null> {
  const response = await context.page.goBack({
    waitUntil: params.waitUntil ?? 'load',
    timeout: params.timeout ?? context.config.timeout,
  });

  return response ? responseOutput(context, response) : null;
}

export async function forward(
  context: BrowserActionContext,
  params: HistoryNavigationParams = {}
): Promise<NavigationOutput | null> {
  const response = await context.page.goForward({
    waitUntil: params.waitUntil ?? 'load',
    timeout: params.timeout ?? context.config.timeout,
  });

  return response ? responseOutput(context, response) : null;
}

export async function reload(
  context: BrowserActionContext,
  params: ReloadParams = {}
): Promise<NavigationOutput | null> {
  const response = await context.page.reload({
    waitUntil: params.waitUntil ?? 'load',
    timeout: params.timeout ?? context.config.timeout,
  });

  return response ? responseOutput(context, response) : null;
}
