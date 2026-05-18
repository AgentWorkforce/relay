import type { Browser as PlaywrightBrowser, BrowserContext, Cookie, Locator, Page } from 'playwright';

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export type LoadState = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export type WaitForSelectorState = 'attached' | 'detached' | 'visible' | 'hidden';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface BrowserConfig {
  /** Browser engine to use. Defaults to chromium. */
  browser?: BrowserEngine;
  /** Run in headless mode. Defaults to true. */
  headless?: boolean;
  /** Browser viewport dimensions. Defaults to 1280x720. */
  viewport?: ViewportSize;
  /** Default action and navigation timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Custom user agent string for new contexts. */
  userAgent?: string;
  /** Extra HTTP headers to send with every request. */
  extraHTTPHeaders?: Record<string, string>;
  /** Extra browser launch arguments. */
  args?: string[];
  /** Capture console messages from the page. Defaults to true. */
  captureConsole?: boolean;
  /** Capture response metadata from the page. Defaults to false. */
  captureNetwork?: boolean;
  /** Keep the browser session open between actions. Defaults to true. */
  persistSession?: boolean;
  /** Capture a screenshot when an action fails. Defaults to false. */
  screenshotOnError?: boolean;
}

export interface ElementSelectorObject {
  /** Selector passed to Playwright's locator API. */
  selector: string;
  /** Optional frame selector resolved with frameLocator before locating the element. */
  frame?: string;
  /** Optional text filter applied to the locator. */
  hasText?: string | RegExp;
  /** Optional zero-based match index. */
  index?: number;
  /** Set false to use the first matching element instead of Playwright strict matching. */
  strict?: boolean;
  /** Default wait state for this selector. */
  state?: WaitForSelectorState;
  /** Selector-specific timeout in milliseconds. */
  timeout?: number;
}

export type ElementSelector = string | ElementSelectorObject;

export interface WaitForSelectorOptions {
  state?: WaitForSelectorState;
  timeout?: number;
}

export interface GotoParams {
  url: string;
  waitUntil?: LoadState;
  timeout?: number;
  referer?: string;
}

export interface HistoryNavigationParams {
  waitUntil?: LoadState;
  timeout?: number;
}

export type ReloadParams = HistoryNavigationParams;

export interface ClickParams {
  selector: ElementSelector;
  waitFor?: boolean | WaitForSelectorOptions;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  timeout?: number;
  force?: boolean;
  noWaitAfter?: boolean;
  position?: { x: number; y: number };
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  trial?: boolean;
}

export interface FillParams {
  selector: ElementSelector;
  value: string;
  waitFor?: boolean | WaitForSelectorOptions;
  timeout?: number;
  force?: boolean;
  /** Defaults to true. When false, text is typed at the current cursor position. */
  clear?: boolean;
}

export interface CheckParams {
  selector: ElementSelector;
  checked?: boolean;
  waitFor?: boolean | WaitForSelectorOptions;
  timeout?: number;
  force?: boolean;
  noWaitAfter?: boolean;
  trial?: boolean;
}

export interface SelectParams {
  selector: ElementSelector;
  values: string | string[];
  waitFor?: boolean | WaitForSelectorOptions;
  timeout?: number;
  force?: boolean;
}

export interface HoverParams {
  selector: ElementSelector;
  waitFor?: boolean | WaitForSelectorOptions;
  timeout?: number;
  force?: boolean;
  position?: { x: number; y: number };
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  trial?: boolean;
}

export interface PressParams {
  selector: ElementSelector;
  key: string;
  waitFor?: boolean | WaitForSelectorOptions;
  timeout?: number;
  delay?: number;
  noWaitAfter?: boolean;
}

export interface SubmitParams {
  selector?: ElementSelector;
  waitForNavigation?: boolean;
  waitUntil?: LoadState;
  timeout?: number;
}

export interface UploadParams {
  selector: ElementSelector;
  filePath: string | string[];
  waitFor?: boolean | WaitForSelectorOptions;
  timeout?: number;
}

export interface TextParams {
  selector?: ElementSelector;
  innerText?: boolean;
  all?: boolean;
  timeout?: number;
}

export interface HtmlParams {
  selector?: ElementSelector;
  outerHTML?: boolean;
  timeout?: number;
}

export interface AttributeParams {
  selector: ElementSelector;
  name: string;
  timeout?: number;
}

export interface ScreenshotParams {
  selector?: ElementSelector;
  path?: string;
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
  timeout?: number;
  omitBackground?: boolean;
  animations?: 'allow' | 'disabled';
  scale?: 'css' | 'device';
}

export interface WaitForSelectorParams extends WaitForSelectorOptions {
  selector: ElementSelector;
}

export interface WaitForNavigationParams {
  url?: string | RegExp;
  waitUntil?: LoadState;
  timeout?: number;
}

export interface WaitForFunctionParams {
  script: string;
  args?: unknown[];
  timeout?: number;
  polling?: 'raf' | number;
}

export interface EvaluateParams {
  script: string;
  args?: unknown[];
  /** When provided, evaluates against this element. The element is passed as arg 0. */
  selector?: ElementSelector;
  timeout?: number;
}

export interface NavigationOutput {
  url: string;
  status: number | null;
  ok: boolean | null;
}

export interface SelectorActionOutput {
  selector: string;
  action: string;
}

export interface TextOutput {
  selector?: string;
  text: string | string[] | null;
}

export interface HtmlOutput {
  selector?: string;
  html: string | null;
}

export interface AttributeOutput {
  selector: string;
  name: string;
  value: string | null;
}

export interface ScreenshotOutput {
  path?: string;
  base64?: string;
  bytes: number;
  type: 'png' | 'jpeg';
  fullPage?: boolean;
  selector?: string;
}

export interface WaitOutput {
  url: string;
  selector?: string;
  state?: WaitForSelectorState;
  value?: unknown;
}

export type BrowserActionName =
  | 'goto'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'fill'
  | 'check'
  | 'uncheck'
  | 'select'
  | 'hover'
  | 'press'
  | 'submit'
  | 'upload'
  | 'text'
  | 'getText'
  | 'html'
  | 'getHTML'
  | 'attribute'
  | 'getAttribute'
  | 'screenshot'
  | 'elementScreenshot'
  | 'waitForSelector'
  | 'waitForElement'
  | 'waitForNavigation'
  | 'waitForFunction'
  | 'evaluate';

export interface BrowserActionParamsMap {
  goto: GotoParams;
  navigate: GotoParams;
  back: HistoryNavigationParams;
  forward: HistoryNavigationParams;
  reload: ReloadParams;
  click: ClickParams;
  fill: FillParams;
  check: CheckParams;
  uncheck: Omit<CheckParams, 'checked'>;
  select: SelectParams;
  hover: HoverParams;
  press: PressParams;
  submit: SubmitParams;
  upload: UploadParams;
  text: TextParams;
  getText: TextParams;
  html: HtmlParams;
  getHTML: HtmlParams;
  attribute: AttributeParams;
  getAttribute: AttributeParams;
  screenshot: ScreenshotParams;
  elementScreenshot: ScreenshotParams & { selector: ElementSelector };
  waitForSelector: WaitForSelectorParams;
  waitForElement: WaitForSelectorParams;
  waitForNavigation: WaitForNavigationParams;
  waitForFunction: WaitForFunctionParams;
  evaluate: EvaluateParams;
}

export interface BrowserActionOutputMap {
  goto: NavigationOutput;
  navigate: NavigationOutput;
  back: NavigationOutput | null;
  forward: NavigationOutput | null;
  reload: NavigationOutput | null;
  click: SelectorActionOutput;
  fill: SelectorActionOutput;
  check: SelectorActionOutput;
  uncheck: SelectorActionOutput;
  select: SelectorActionOutput & { values: string[] };
  hover: SelectorActionOutput;
  press: SelectorActionOutput & { key: string };
  submit: SelectorActionOutput;
  upload: SelectorActionOutput & { files: string[] };
  text: TextOutput;
  getText: TextOutput;
  html: HtmlOutput;
  getHTML: HtmlOutput;
  attribute: AttributeOutput;
  getAttribute: AttributeOutput;
  screenshot: ScreenshotOutput;
  elementScreenshot: ScreenshotOutput;
  waitForSelector: WaitOutput;
  waitForElement: WaitOutput;
  waitForNavigation: WaitOutput;
  waitForFunction: WaitOutput;
  evaluate: unknown;
}

export type BrowserAction<TName extends BrowserActionName = BrowserActionName> = {
  [Name in TName]: {
    type: Name;
    params: BrowserActionParamsMap[Name];
  };
}[TName];

export type BrowserWorkflowAction<TName extends BrowserActionName = BrowserActionName> = {
  [Name in TName]: {
    action: Name;
    params: BrowserActionParamsMap[Name];
  };
}[TName];

export type BrowserActionRequest<TName extends BrowserActionName = BrowserActionName> =
  | BrowserAction<TName>
  | BrowserWorkflowAction<TName>;

export interface ConsoleMessage {
  type: 'log' | 'error' | 'warn' | 'info' | 'debug';
  text: string;
  timestamp: Date;
  location?: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  responseTime: number;
  timestamp: Date;
  error?: string;
}

export interface BrowserSession {
  id: string;
  config: RequiredBrowserConfig;
  currentUrl?: string;
  cookies: Cookie[];
  consoleLogs: ConsoleMessage[];
  networkLogs: NetworkRequest[];
  startTime: Date;
  active: boolean;
}

export interface ActionResultMetadata {
  action?: BrowserActionName;
  sessionId?: string;
  currentUrl?: string;
  executionTime?: number;
  startedAt?: string;
  endedAt?: string;
  errorScreenshot?: string;
  consoleLogs?: ConsoleMessage[];
  networkActivity?: NetworkRequest[];
}

export interface ActionResult<TOutput = unknown> {
  success: boolean;
  output?: TOutput;
  error?: string;
  metadata?: ActionResultMetadata;
}

export type BrowserActionResult<TOutput = unknown> = ActionResult<TOutput>;

export interface RequiredBrowserConfig {
  browser: BrowserEngine;
  headless: boolean;
  viewport: ViewportSize;
  timeout: number;
  userAgent?: string;
  extraHTTPHeaders?: Record<string, string>;
  args: string[];
  captureConsole: boolean;
  captureNetwork: boolean;
  persistSession: boolean;
  screenshotOnError: boolean;
}

export interface BrowserActionContext {
  page: Page;
  config: RequiredBrowserConfig;
  resolveLocator(selector: ElementSelector): Locator;
  waitForElement(selector: ElementSelector, options?: WaitForSelectorOptions): Promise<Locator>;
}

export type { BrowserContext, Locator, Page, PlaywrightBrowser };
