import {
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type BrowserType,
  type ConsoleMessage as PlaywrightConsoleMessage,
  type Page,
  type Request,
} from 'playwright';

import { attribute, html, screenshot, text } from './actions/extraction.js';
import { check, click, fill, hover, press, select, submit, uncheck, upload } from './actions/interaction.js';
import { back, forward, goto, reload } from './actions/navigation.js';
import { evaluate } from './actions/script.js';
import { waitForFunction, waitForNavigation, waitForSelector } from './actions/waits.js';
import type {
  ActionResult,
  BrowserAction,
  BrowserActionContext,
  BrowserActionName,
  BrowserActionOutputMap,
  BrowserActionParamsMap,
  BrowserActionRequest,
  BrowserConfig,
  BrowserSession,
  ConsoleMessage,
  ElementSelector,
  PlaywrightBrowser,
  RequiredBrowserConfig,
  ScreenshotOutput,
} from './types.js';

type UnknownActionRequest = {
  type?: string;
  action?: string;
  params?: unknown;
};

type ActionHandler = (context: BrowserActionContext, params: unknown) => Promise<unknown>;

const ACTION_HANDLERS: Record<BrowserActionName, ActionHandler> = {
  goto: goto as ActionHandler,
  navigate: goto as ActionHandler,
  back: back as ActionHandler,
  forward: forward as ActionHandler,
  reload: reload as ActionHandler,
  click: click as ActionHandler,
  fill: fill as ActionHandler,
  check: check as ActionHandler,
  uncheck: uncheck as ActionHandler,
  select: select as ActionHandler,
  hover: hover as ActionHandler,
  press: press as ActionHandler,
  submit: submit as ActionHandler,
  upload: upload as ActionHandler,
  text: text as ActionHandler,
  getText: text as ActionHandler,
  html: html as ActionHandler,
  getHTML: html as ActionHandler,
  attribute: attribute as ActionHandler,
  getAttribute: attribute as ActionHandler,
  screenshot: screenshot as ActionHandler,
  elementScreenshot: screenshot as ActionHandler,
  waitForSelector: waitForSelector as ActionHandler,
  waitForElement: waitForSelector as ActionHandler,
  waitForNavigation: waitForNavigation as ActionHandler,
  waitForFunction: waitForFunction as ActionHandler,
  evaluate: evaluate as ActionHandler,
};

const DEFAULT_CONFIG: RequiredBrowserConfig = {
  browser: 'chromium',
  headless: true,
  viewport: {
    width: 1280,
    height: 720,
  },
  timeout: 30_000,
  args: [],
  captureConsole: true,
  captureNetwork: false,
  persistSession: true,
  screenshotOnError: false,
};

export interface BrowserClientOptions {
  config?: BrowserConfig;
}

export class BrowserClient {
  private readonly config: RequiredBrowserConfig;
  private readonly session: BrowserSession;
  private browser?: PlaywrightBrowser;
  private context?: BrowserContext;
  private page?: Page;
  private queueTail: Promise<void> = Promise.resolve();

  constructor(options: BrowserClientOptions = {}) {
    this.config = normalizeConfig(options.config);
    this.session = {
      id: createSessionId(),
      config: this.config,
      cookies: [],
      consoleLogs: [],
      networkLogs: [],
      startTime: new Date(),
      active: false,
    };
  }

  getSession(): BrowserSession {
    return this.session;
  }

  getPage(): Page | undefined {
    return this.page && !this.page.isClosed() ? this.page : undefined;
  }

  getCurrentUrl(): string | undefined {
    return this.page && !this.page.isClosed() ? this.page.url() : undefined;
  }

  async launch(): Promise<BrowserSession> {
    if (this.browser?.isConnected() && this.context && this.getPage()) {
      return this.session;
    }

    if (this.browser?.isConnected() && this.context) {
      this.page = await this.createPage();
      return this.session;
    }

    const launcher = this.getBrowserType();
    this.browser = await launcher.launch({
      headless: this.config.headless,
      args: this.config.args,
      timeout: this.config.timeout,
    });
    this.context = await this.browser.newContext({
      viewport: this.config.viewport,
      userAgent: this.config.userAgent,
      extraHTTPHeaders: this.config.extraHTTPHeaders,
    });
    this.page = await this.createPage();
    this.session.active = true;

    return this.session;
  }

  async newPage(): Promise<Page> {
    if (!this.context || !this.browser?.isConnected()) {
      await this.launch();
      return this.page as Page;
    }

    this.page = await this.createPage();
    return this.page;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.refreshSessionState().catch(() => undefined);
      await this.context.close().catch(() => undefined);
    }

    if (this.browser?.isConnected()) {
      await this.browser.close().catch(() => undefined);
    }

    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.session.active = false;
  }

  async reset(config?: BrowserConfig): Promise<BrowserSession> {
    await this.close();

    if (config) {
      Object.assign(this.config, normalizeConfig({ ...this.config, ...config }));
      this.session.config = this.config;
    }

    this.session.cookies = [];
    this.session.consoleLogs = [];
    this.session.networkLogs = [];
    this.session.currentUrl = undefined;
    this.session.startTime = new Date();

    return this.launch();
  }

  execute<Name extends BrowserActionName>(
    action: Name,
    params: BrowserActionParamsMap[Name]
  ): Promise<ActionResult<BrowserActionOutputMap[Name]>>;
  execute<Name extends BrowserActionName>(
    action: BrowserAction<Name>
  ): Promise<ActionResult<BrowserActionOutputMap[Name]>>;
  execute<Name extends BrowserActionName>(
    action: BrowserActionRequest<Name>
  ): Promise<ActionResult<BrowserActionOutputMap[Name]>>;
  execute<TOutput = unknown>(
    action: BrowserActionRequest | BrowserActionName | UnknownActionRequest,
    params?: unknown
  ): Promise<ActionResult<TOutput>> {
    try {
      const request = this.normalizeAction(action, params);
      return this.queueAction<TOutput>(request.name, request.params);
    } catch (error) {
      return Promise.resolve(this.normalizationError<TOutput>(error));
    }
  }

  enqueue<Name extends BrowserActionName>(
    action: Name,
    params: BrowserActionParamsMap[Name]
  ): Promise<ActionResult<BrowserActionOutputMap[Name]>> {
    return this.execute(action, params);
  }

  async executeMany(actions: BrowserActionRequest[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const action of actions) {
      results.push(await this.executeWorkflowAction(action));
    }

    return results;
  }

  executeWorkflowAction<Name extends BrowserActionName>(
    action: BrowserActionRequest<Name>
  ): Promise<ActionResult<BrowserActionOutputMap[Name]>>;
  executeWorkflowAction<TOutput = unknown>(action: BrowserActionRequest): Promise<ActionResult<TOutput>> {
    try {
      const request = this.normalizeAction(action);
      return this.queueAction<TOutput>(request.name, request.params);
    } catch (error) {
      return Promise.resolve(this.normalizationError<TOutput>(error));
    }
  }

  private queueAction<TOutput>(action: BrowserActionName, params: unknown): Promise<ActionResult<TOutput>> {
    const run = this.queueTail.then(() => this.executeNow<TOutput>(action, params));

    this.queueTail = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  }

  private normalizationError<TOutput>(error: unknown): ActionResult<TOutput> {
    const now = new Date().toISOString();

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        sessionId: this.session.id,
        startedAt: now,
        endedAt: now,
        executionTime: 0,
      },
    };
  }

  private async executeNow<TOutput>(
    action: BrowserActionName,
    params: unknown
  ): Promise<ActionResult<TOutput>> {
    const handler = ACTION_HANDLERS[action];
    const startedAt = new Date();
    const startTime = Date.now();
    const consoleStart = this.session.consoleLogs.length;
    const networkStart = this.session.networkLogs.length;

    if (!handler) {
      return {
        success: false,
        error: `Unsupported browser action: ${action}`,
        metadata: {
          action,
          sessionId: this.session.id,
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          executionTime: Date.now() - startTime,
        },
      };
    }

    let page: Page | undefined;

    try {
      page = await this.ensurePage();
      const output = (await handler(this.createActionContext(page), params)) as TOutput;

      await this.refreshSessionState();

      return {
        success: true,
        output,
        metadata: this.createMetadata(action, startedAt, startTime, consoleStart, networkStart),
      };
    } catch (error) {
      const errorScreenshot = page ? await this.captureErrorScreenshot(page, action) : undefined;

      await this.refreshSessionState().catch(() => undefined);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: this.createMetadata(
          action,
          startedAt,
          startTime,
          consoleStart,
          networkStart,
          errorScreenshot
        ),
      };
    } finally {
      if (!this.config.persistSession) {
        await this.close();
      }
    }
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser?.isConnected() || !this.context) {
      await this.launch();
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.createPage();
    }

    return this.page;
  }

  private async createPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('Browser context is not available');
    }

    const page = await this.context.newPage();
    page.setDefaultTimeout(this.config.timeout);
    page.setDefaultNavigationTimeout(this.config.timeout);
    this.attachPageObservers(page);

    return page;
  }

  private createActionContext(page: Page): BrowserActionContext {
    return {
      page,
      config: this.config,
      resolveLocator: (selector) => this.resolveLocator(page, selector),
      waitForElement: async (selector, options) => {
        const normalized = normalizeSelector(selector);
        const locator = this.resolveLocator(page, normalized);

        await locator.waitFor({
          state: options?.state ?? normalized.state ?? 'visible',
          timeout: options?.timeout ?? normalized.timeout ?? this.config.timeout,
        });

        return locator;
      },
    };
  }

  private resolveLocator(page: Page, selector: ElementSelector) {
    const normalized = normalizeSelector(selector);
    const root = normalized.frame ? page.frameLocator(normalized.frame) : page;
    let locator = root.locator(normalized.selector);

    if (normalized.hasText !== undefined) {
      locator = locator.filter({ hasText: normalized.hasText });
    }

    if (normalized.index !== undefined) {
      return locator.nth(normalized.index);
    }

    if (normalized.strict === false) {
      return locator.first();
    }

    return locator;
  }

  private async refreshSessionState(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      this.session.currentUrl = this.page.url();
    }

    if (this.context) {
      this.session.cookies = await this.context.cookies();
    }
  }

  private createMetadata(
    action: BrowserActionName,
    startedAt: Date,
    startTime: number,
    consoleStart: number,
    networkStart: number,
    errorScreenshot?: string
  ) {
    const endedAt = new Date();

    return {
      action,
      sessionId: this.session.id,
      currentUrl: this.session.currentUrl,
      executionTime: Date.now() - startTime,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      errorScreenshot,
      consoleLogs: this.session.consoleLogs.slice(consoleStart),
      networkActivity: this.session.networkLogs.slice(networkStart),
    };
  }

  private async captureErrorScreenshot(page: Page, action: BrowserActionName): Promise<string | undefined> {
    if (!this.config.screenshotOnError || page.isClosed()) {
      return undefined;
    }

    try {
      const output = (await screenshot(this.createActionContext(page), {
        type: 'png',
      })) as ScreenshotOutput;

      return output.base64
        ? `data:image/png;base64,${output.base64}`
        : (output.path ?? `browser-error-${action}.png`);
    } catch {
      return undefined;
    }
  }

  private attachPageObservers(page: Page): void {
    if (this.config.captureConsole) {
      page.on('console', (message) => {
        this.session.consoleLogs.push(toConsoleMessage(message));
      });
      page.on('pageerror', (error) => {
        this.session.consoleLogs.push({
          type: 'error',
          text: error.message,
          timestamp: new Date(),
        });
      });
    }

    if (this.config.captureNetwork) {
      const started = new Map<Request, number>();

      page.on('request', (request) => {
        started.set(request, Date.now());
      });
      page.on('response', (response) => {
        const request = response.request();
        const startedAt = started.get(request) ?? Date.now();
        started.delete(request);
        this.session.networkLogs.push({
          url: response.url(),
          method: request.method(),
          status: response.status(),
          responseTime: Date.now() - startedAt,
          timestamp: new Date(),
        });
      });
      page.on('requestfailed', (request) => {
        const startedAt = started.get(request) ?? Date.now();
        started.delete(request);
        this.session.networkLogs.push({
          url: request.url(),
          method: request.method(),
          status: 0,
          responseTime: Date.now() - startedAt,
          timestamp: new Date(),
          error: request.failure()?.errorText,
        });
      });
    }
  }

  private getBrowserType(): BrowserType {
    switch (this.config.browser) {
      case 'firefox':
        return firefox;
      case 'webkit':
        return webkit;
      case 'chromium':
      default:
        return chromium;
    }
  }

  private normalizeAction(
    action: BrowserActionRequest | BrowserActionName | UnknownActionRequest,
    params?: unknown
  ): { name: BrowserActionName; params: unknown } {
    if (typeof action === 'string') {
      return {
        name: action,
        params: params ?? {},
      };
    }

    const request = action as UnknownActionRequest;
    const name = request.type ?? request.action;

    if (!name) {
      throw new Error('Browser action must include a type or action field');
    }

    return {
      name: name as BrowserActionName,
      params: request.params ?? params ?? {},
    };
  }
}

function normalizeConfig(config: BrowserConfig = {}): RequiredBrowserConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    viewport: config.viewport ?? DEFAULT_CONFIG.viewport,
    args: [...(config.args ?? DEFAULT_CONFIG.args)],
    captureConsole: config.captureConsole ?? DEFAULT_CONFIG.captureConsole,
    captureNetwork: config.captureNetwork ?? DEFAULT_CONFIG.captureNetwork,
    persistSession: config.persistSession ?? DEFAULT_CONFIG.persistSession,
    screenshotOnError: config.screenshotOnError ?? DEFAULT_CONFIG.screenshotOnError,
  };
}

function normalizeSelector(selector: ElementSelector) {
  return typeof selector === 'string'
    ? {
        selector,
      }
    : selector;
}

function toConsoleMessage(message: PlaywrightConsoleMessage): ConsoleMessage {
  const location = message.location();
  const locationText = location.url
    ? `${location.url}:${location.lineNumber}:${location.columnNumber}`
    : undefined;

  return {
    type: normalizeConsoleType(message.type()),
    text: message.text(),
    timestamp: new Date(),
    location: locationText,
  };
}

function normalizeConsoleType(type: string): ConsoleMessage['type'] {
  switch (type) {
    case 'debug':
    case 'error':
    case 'info':
    case 'log':
      return type;
    case 'warning':
    case 'warn':
      return 'warn';
    default:
      return 'log';
  }
}

function createSessionId(): string {
  return `browser_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
