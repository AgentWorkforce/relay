# Browser Workflow Primitive

A workflow primitive that enables agents to perform browser automation using Playwright, designed to complement the existing GitHub and other integration primitives.

## Package Structure

```
packages/primitives/browser/
├── DESIGN.md                 # This design document
├── package.json             # Package manifest
├── src/
│   ├── index.ts            # Main exports
│   ├── types.ts            # TypeScript interfaces
│   ├── executor.ts         # Browser action executor
│   ├── session.ts          # Browser session management
│   ├── actions/            # Browser action implementations
│   │   ├── navigation.ts   # navigate, reload, back, forward
│   │   ├── interaction.ts  # click, fill, submit, hover
│   │   ├── extraction.ts   # getText, getHTML, getAttribute
│   │   ├── screenshot.ts   # screenshot, elementScreenshot
│   │   ├── javascript.ts   # evaluate, addScript
│   │   └── iframe.ts       # iframe handling
│   ├── utils/
│   │   ├── selector.ts     # Selector validation and enhancement
│   │   ├── wait.ts        # Waiting strategies
│   │   └── console.ts     # Console log capture
│   └── __tests__/
│       ├── actions/        # Action unit tests
│       ├── integration/    # Integration tests
│       └── fixtures/       # Test HTML files
├── templates/              # Workflow templates
│   ├── web-scraping.yaml  # Data extraction workflow
│   ├── form-filling.yaml  # Form automation workflow
│   └── e2e-testing.yaml   # End-to-end testing workflow
├── docs/
│   ├── getting-started.md # Usage guide
│   ├── actions.md         # Action reference
│   └── examples.md        # Example workflows
└── README.md              # Package overview
```

## TypeScript Interfaces

### Core Action Types

```typescript
// Browser action types that map to workflow step actions
export type BrowserAction = 
  | 'navigate'
  | 'click'
  | 'fill'
  | 'submit'
  | 'waitForElement'
  | 'waitForNavigation'
  | 'screenshot'
  | 'elementScreenshot'
  | 'getText'
  | 'getHTML'
  | 'getAttribute'
  | 'evaluate'
  | 'addScript'
  | 'reload'
  | 'back'
  | 'forward'
  | 'hover'
  | 'select'
  | 'upload'
  | 'switchFrame'
  | 'clearCookies'
  | 'setCookie'
  | 'setHeaders';

// Browser configuration for session setup
export interface BrowserConfig {
  /** Browser engine to use */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Run in headless mode (default: true) */
  headless?: boolean;
  /** Viewport dimensions */
  viewport?: { width: number; height: number };
  /** Navigation timeout in ms (default: 30000) */
  timeout?: number;
  /** Custom user agent string */
  userAgent?: string;
  /** Extra HTTP headers to send with requests */
  extraHTTPHeaders?: Record<string, string>;
  /** Browser launch arguments */
  args?: string[];
  /** Enable browser console log capture (default: true) */
  captureConsole?: boolean;
  /** Enable network request logging (default: false) */
  captureNetwork?: boolean;
  /** Session persistence between actions */
  persistSession?: boolean;
}

// Action parameter interfaces
export interface NavigateParams {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface ClickParams {
  selector: string;
  /** Wait for element to exist before clicking */
  waitFor?: boolean;
  /** Force click even if element is not visible */
  force?: boolean;
  /** Click position relative to element */
  position?: { x: number; y: number };
}

export interface FillParams {
  selector: string;
  value: string;
  /** Clear existing value before filling */
  clear?: boolean;
}

export interface SubmitParams {
  /** Form selector, if not provided submits the first form */
  selector?: string;
  /** Wait for navigation after submit */
  waitForNavigation?: boolean;
}

export interface WaitForElementParams {
  selector: string;
  /** Wait condition */
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  /** Timeout in ms */
  timeout?: number;
}

export interface ScreenshotParams {
  /** Element selector for partial screenshot */
  selector?: string;
  /** Output file path (relative to workflow working directory) */
  path?: string;
  /** Full page screenshot */
  fullPage?: boolean;
  /** Screenshot format */
  type?: 'png' | 'jpeg';
  /** JPEG quality (0-100) */
  quality?: number;
}

export interface GetTextParams {
  selector: string;
  /** Get inner text vs text content */
  innerText?: boolean;
}

export interface GetHTMLParams {
  selector?: string;
  /** Get outer HTML vs inner HTML */
  outerHTML?: boolean;
}

export interface EvaluateParams {
  /** JavaScript code to execute */
  script: string;
  /** Arguments to pass to the script */
  args?: unknown[];
}

export interface SetCookieParams {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}
```

### Session and State Management

```typescript
// Browser session state
export interface BrowserSession {
  /** Session ID for tracking */
  id: string;
  /** Browser instance configuration */
  config: BrowserConfig;
  /** Current page URL */
  currentUrl?: string;
  /** Session cookies */
  cookies: Cookie[];
  /** Console logs from this session */
  consoleLogs: ConsoleMessage[];
  /** Network requests (if enabled) */
  networkLogs?: NetworkRequest[];
  /** Session start time */
  startTime: Date;
  /** Whether session is currently active */
  active: boolean;
}

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
}

// Action execution result
export interface BrowserActionResult {
  /** Whether action succeeded */
  success: boolean;
  /** Action output (text, HTML, screenshot path, etc.) */
  output: string;
  /** Error message if action failed */
  error?: string;
  /** Additional metadata */
  metadata?: {
    /** Current page URL after action */
    currentUrl?: string;
    /** Screenshot path if taken automatically on error */
    errorScreenshot?: string;
    /** Console logs during action */
    consoleLogs?: ConsoleMessage[];
    /** Network activity during action */
    networkActivity?: NetworkRequest[];
    /** Action execution time in ms */
    executionTime?: number;
  };
}
```

## Step Configuration Schema

Browser steps integrate into workflows using the existing integration step pattern:

```yaml
steps:
  - name: login-to-app
    type: integration
    integration: browser
    action: navigate
    params:
      url: "https://app.example.com/login"
      waitUntil: "networkidle"
    
  - name: fill-credentials
    type: integration  
    integration: browser
    action: fill
    params:
      selector: 'input[name="email"]'
      value: "{{steps.get-credentials.output.email}}"
      
  - name: submit-login
    type: integration
    integration: browser
    action: submit
    params:
      selector: 'form#login-form'
      waitForNavigation: "true"
      
  - name: capture-dashboard
    type: integration
    integration: browser
    action: screenshot
    params:
      path: "dashboard-screenshot.png"
      fullPage: "true"
```

### Global Browser Configuration

Browser configuration can be set at the workflow level:

```yaml
# Global browser configuration
browserConfig:
  headless: false
  viewport:
    width: 1920
    height: 1080
  timeout: 30000
  captureConsole: true
  persistSession: true

steps:
  # Browser steps inherit global config
  - name: navigate-home
    type: integration
    integration: browser
    action: navigate
    params:
      url: "https://example.com"
```

### Step-Level Configuration Override

Individual steps can override global browser config:

```yaml
steps:
  - name: mobile-test
    type: integration
    integration: browser
    action: navigate
    params:
      url: "https://example.com"
      # Step-specific browser config
      browserConfig:
        viewport:
          width: 375
          height: 667
        userAgent: "Mobile Safari"
```

## Example Workflow Usage

### 1. Data Extraction Workflow

```yaml
version: "1.0"
name: extract-product-data
description: Extract product information from e-commerce site

browserConfig:
  headless: true
  captureConsole: false
  persistSession: true

steps:
  - name: navigate-to-products
    type: integration
    integration: browser
    action: navigate
    params:
      url: "https://store.example.com/products"
      waitUntil: "networkidle"
      
  - name: search-for-item
    type: integration
    integration: browser
    action: fill
    params:
      selector: 'input[name="search"]'
      value: "{{workflow.searchTerm}}"
      
  - name: submit-search
    type: integration
    integration: browser
    action: submit
    params:
      selector: 'form.search-form'
      waitForNavigation: true
      
  - name: extract-product-titles
    type: integration
    integration: browser
    action: evaluate
    params:
      script: |
        Array.from(document.querySelectorAll('.product-title'))
          .map(el => el.textContent.trim())
      
  - name: capture-results-page
    type: integration
    integration: browser
    action: screenshot
    params:
      path: "search-results-{{workflow.searchTerm}}.png"
```

### 2. Form Automation Workflow

```yaml
version: "1.0"
name: submit-application
description: Automate job application form submission

browserConfig:
  headless: false
  timeout: 45000
  persistSession: true

steps:
  - name: navigate-to-application
    type: integration
    integration: browser
    action: navigate
    params:
      url: "{{steps.get-job-url.output}}"
      
  - name: fill-personal-info
    type: integration
    integration: browser
    action: fill
    params:
      selector: 'input[name="fullName"]'
      value: "{{steps.get-applicant-data.output.name}}"
      
  - name: fill-email
    type: integration
    integration: browser
    action: fill
    params:
      selector: 'input[name="email"]'
      value: "{{steps.get-applicant-data.output.email}}"
      
  - name: upload-resume
    type: integration
    integration: browser
    action: upload
    params:
      selector: 'input[type="file"]'
      filePath: "{{steps.generate-resume.output.filePath}}"
      
  - name: submit-application
    type: integration
    integration: browser
    action: submit
    params:
      selector: 'form.application-form'
      waitForNavigation: true
      
  - name: capture-confirmation
    type: integration
    integration: browser
    action: screenshot
    params:
      path: "application-confirmation.png"
      
  - name: get-confirmation-text
    type: integration
    integration: browser
    action: getText
    params:
      selector: '.confirmation-message'
```

### 3. Multi-Step Testing Workflow

```yaml
version: "1.0"
name: e2e-user-journey
description: End-to-end test of user signup and onboarding

browserConfig:
  headless: true
  captureConsole: true
  captureNetwork: true

steps:
  - name: navigate-home
    type: integration
    integration: browser
    action: navigate
    params:
      url: "https://app.example.com"
      
  - name: click-signup
    type: integration
    integration: browser
    action: click
    params:
      selector: 'a[href="/signup"]'
      waitFor: true
      
  - name: wait-for-signup-form
    type: integration
    integration: browser
    action: waitForElement
    params:
      selector: 'form#signup-form'
      state: "visible"
      timeout: 10000
      
  - name: fill-signup-form
    type: integration
    integration: browser
    action: evaluate
    params:
      script: |
        document.querySelector('input[name="email"]').value = '{{workflow.testEmail}}';
        document.querySelector('input[name="password"]').value = '{{workflow.testPassword}}';
        document.querySelector('input[name="confirmPassword"]').value = '{{workflow.testPassword}}';
        
  - name: submit-signup
    type: integration
    integration: browser
    action: submit
    params:
      selector: 'form#signup-form'
      waitForNavigation: true
      
  - name: verify-welcome-message
    type: integration
    integration: browser
    action: waitForElement
    params:
      selector: '.welcome-message'
      state: "visible"
      
  - name: capture-onboarding-screen
    type: integration
    integration: browser
    action: screenshot
    params:
      path: "onboarding-welcome.png"
```

## Integration with Existing Workflow System

### Executor Interface Implementation

The browser primitive implements the `WorkflowExecutor.executeIntegrationStep` interface:

```typescript
export class BrowserExecutor implements WorkflowExecutor {
  async executeIntegrationStep(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: { workspaceId?: string }
  ): Promise<{ output: string; success: boolean }> {
    
    if (step.integration !== 'browser') {
      throw new Error(`BrowserExecutor only handles browser integration steps`);
    }
    
    try {
      const result = await this.executeBrowserAction(
        step.action as BrowserAction,
        resolvedParams,
        context
      );
      
      return {
        output: result.output,
        success: result.success
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        success: false
      };
    }
  }
  
  private async executeBrowserAction(
    action: BrowserAction,
    params: Record<string, string>,
    context: { workspaceId?: string }
  ): Promise<BrowserActionResult> {
    // Implementation details...
  }
}
```

### Session Management

Sessions persist across steps when `persistSession: true`:

```typescript
export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();
  
  async getOrCreateSession(
    workspaceId: string, 
    config: BrowserConfig
  ): Promise<BrowserSession> {
    const sessionKey = `${workspaceId}:${JSON.stringify(config)}`;
    
    if (this.sessions.has(sessionKey)) {
      return this.sessions.get(sessionKey)!;
    }
    
    const session = await this.createSession(config);
    this.sessions.set(sessionKey, session);
    return session;
  }
  
  async cleanupSession(sessionId: string): Promise<void> {
    // Cleanup browser resources
  }
}
```

### Error Handling and Recovery

The browser executor provides robust error handling:

1. **Automatic Screenshots**: Captures screenshot on action failure for debugging
2. **Retry Logic**: Configurable retry attempts for transient failures  
3. **Timeout Management**: Respects workflow-level and action-level timeouts
4. **Graceful Degradation**: Falls back to alternative selectors when primary fails

### Output Chaining

Browser actions output results that can be chained to subsequent steps:

```yaml
steps:
  - name: extract-product-price
    type: integration
    integration: browser
    action: getText
    params:
      selector: '.price'
      
  - name: compare-price
    type: agent
    agent: price-analyst
    task: "Analyze if price {{steps.extract-product-price.output}} is competitive"
```

## Agent Interaction Features

### Real-time Console Capture

When `captureConsole: true`, all browser console messages are captured and can be accessed:

```typescript
// Console logs are included in action metadata
{
  success: true,
  output: "Login successful",
  metadata: {
    consoleLogs: [
      { type: 'log', text: 'User authenticated', timestamp: new Date() },
      { type: 'error', text: 'Analytics script failed', timestamp: new Date() }
    ]
  }
}
```

### Network Request Logging

When `captureNetwork: true`, HTTP requests are logged:

```typescript
{
  success: true,
  output: "Page loaded",
  metadata: {
    networkActivity: [
      { url: '/api/user', method: 'GET', status: 200, responseTime: 150 },
      { url: '/api/preferences', method: 'GET', status: 200, responseTime: 89 }
    ]
  }
}
```

### Error Capture and Reporting

Detailed error information helps agents understand failures:

```typescript
{
  success: false,
  output: "",
  error: "Element not found: .submit-button",
  metadata: {
    currentUrl: "https://example.com/form",
    errorScreenshot: "error-step-submit-20241210-143022.png",
    consoleLogs: [
      { type: 'error', text: 'Submit button removed by JS', timestamp: new Date() }
    ]
  }
}
```

## Integration Examples

### With GitHub Primitive

```yaml
steps:
  - name: test-deployment
    type: integration
    integration: browser  
    action: navigate
    params:
      url: "{{steps.deploy-to-staging.output.url}}"
      
  - name: run-smoke-tests
    type: integration
    integration: browser
    action: evaluate
    params:
      script: |
        // Run basic functionality tests
        const results = [];
        // ... test implementation
        return JSON.stringify(results);
        
  - name: create-test-report
    type: integration
    integration: github
    action: create-issue
    params:
      title: "Smoke Test Results"
      body: |
        Deployment URL: {{steps.test-deployment.output}}
        Test Results: {{steps.run-smoke-tests.output}}
```

### With Slack Integration

```yaml
steps:
  - name: monitor-checkout-flow
    type: integration
    integration: browser
    action: navigate
    params:
      url: "https://store.example.com/checkout"
      
  - name: capture-checkout-error
    type: integration
    integration: browser
    action: screenshot
    params:
      path: "checkout-error.png"
      selector: ".error-message"
      
  - name: alert-team
    type: integration  
    integration: slack
    action: post-message
    params:
      channel: "#alerts"
      text: |
        🚨 Checkout flow error detected
        Screenshot: {{steps.capture-checkout-error.output}}
```

## Security Considerations

1. **Sandboxing**: Browser instances run in isolated containers
2. **URL Validation**: Configurable allowlist/denylist for navigation targets  
3. **File Access**: Upload/download operations respect workflow file permissions
4. **Credential Management**: Secure handling of authentication data
5. **Network Isolation**: Optional network access restrictions

## Implementation Priorities

### Phase 1: Core Actions (Week 1-2)
- [ ] Basic navigation (navigate, reload, back, forward)
- [ ] Element interaction (click, fill, submit)  
- [ ] Content extraction (getText, getHTML)
- [ ] Screenshot capture
- [ ] Session management

### Phase 2: Advanced Features (Week 3-4)
- [ ] JavaScript execution (evaluate, addScript)
- [ ] Iframe handling
- [ ] File upload/download
- [ ] Cookie and header management
- [ ] Network request logging

### Phase 3: Workflow Integration (Week 5-6)  
- [ ] Executor implementation
- [ ] Error handling and recovery
- [ ] Output chaining support
- [ ] Template workflows
- [ ] Documentation and examples

### Phase 4: Production Readiness (Week 7-8)
- [ ] Comprehensive test suite
- [ ] Performance optimization  
- [ ] Security hardening
- [ ] Monitoring and observability
- [ ] CI/CD integration

This design provides a comprehensive browser automation primitive that integrates seamlessly with the existing relay workflow system while offering powerful capabilities for web interaction, testing, and data extraction workflows.