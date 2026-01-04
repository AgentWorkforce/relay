/**
 * Browser Testing Service
 *
 * Provides browser automation capabilities for agents running in the workspace.
 * Uses Playwright for browser control and Xvfb for headless display.
 *
 * Features:
 * - Screenshot capture
 * - Browser automation via Playwright
 * - Visual regression testing
 * - PDF generation
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface ScreenshotOptions {
  /** Output path for screenshot (default: /tmp/screenshot-{timestamp}.png) */
  outputPath?: string;
  /** Full page screenshot */
  fullPage?: boolean;
  /** Clip region */
  clip?: { x: number; y: number; width: number; height: number };
}

export interface BrowserTestOptions {
  /** Browser to use (chromium, firefox, webkit) */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Headless mode (default: true in container, false with VNC) */
  headless?: boolean;
  /** Viewport size */
  viewport?: { width: number; height: number };
  /** Timeout in ms */
  timeout?: number;
}

/**
 * Check if browser testing is available
 */
export function isBrowserTestingAvailable(): boolean {
  try {
    // Check if DISPLAY is set (Xvfb running)
    if (!process.env.DISPLAY) {
      return false;
    }

    // Check if Playwright is installed
    execSync('npx playwright --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take a screenshot of the current display
 */
export async function takeDisplayScreenshot(
  options: ScreenshotOptions = {}
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = options.outputPath || `/tmp/screenshot-${timestamp}.png`;

  // Ensure output directory exists
  const dir = join(outputPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const args = [outputPath];
    if (options.fullPage) {
      args.unshift('-u'); // Capture including window decorations
    }

    const proc = spawn('scrot', args, {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
      } else {
        reject(new Error(`Screenshot failed with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Run a Playwright test file
 */
export async function runPlaywrightTest(
  testFile: string,
  options: BrowserTestOptions = {}
): Promise<{ success: boolean; output: string; screenshots: string[] }> {
  const browser = options.browser || 'chromium';
  const timeout = options.timeout || 30000;

  return new Promise((resolve) => {
    const args = ['playwright', 'test', testFile, `--project=${browser}`];

    if (options.headless !== false) {
      args.push('--headed=false');
    }

    const proc = spawn('npx', args, {
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':99',
        PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
      },
      timeout,
    });

    let output = '';
    const screenshots: string[] = [];

    proc.stdout.on('data', (data) => {
      output += data.toString();
      // Parse screenshot paths from output
      const matches = data.toString().match(/Screenshot saved: (.+\.png)/g);
      if (matches) {
        screenshots.push(...matches.map((m: string) => m.replace('Screenshot saved: ', '')));
      }
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output,
        screenshots,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: err.message,
        screenshots: [],
      });
    });
  });
}

/**
 * Launch a browser and navigate to a URL
 * Returns the browser PID for later control
 */
export async function launchBrowser(
  url: string,
  options: { browser?: 'chromium' | 'firefox' } = {}
): Promise<{ pid: number }> {
  const browser = options.browser || 'chromium';
  const command = browser === 'firefox' ? 'firefox' : 'chromium';

  return new Promise((resolve, reject) => {
    const args =
      browser === 'chromium'
        ? ['--no-sandbox', '--disable-gpu', '--start-maximized', url]
        : ['--new-window', url];

    const proc = spawn(command, args, {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
      detached: true,
      stdio: 'ignore',
    });

    proc.unref();

    // Give browser time to start
    setTimeout(() => {
      if (proc.pid) {
        resolve({ pid: proc.pid });
      } else {
        reject(new Error('Failed to launch browser'));
      }
    }, 1000);
  });
}

/**
 * Generate a Playwright test file from a description
 */
export function generatePlaywrightTest(
  name: string,
  steps: Array<{
    action: 'goto' | 'click' | 'fill' | 'screenshot' | 'wait';
    target?: string;
    value?: string;
  }>
): string {
  const testCode = `
import { test, expect } from '@playwright/test';

test('${name}', async ({ page }) => {
${steps
  .map((step) => {
    switch (step.action) {
      case 'goto':
        return `  await page.goto('${step.target}');`;
      case 'click':
        return `  await page.click('${step.target}');`;
      case 'fill':
        return `  await page.fill('${step.target}', '${step.value}');`;
      case 'screenshot':
        return `  await page.screenshot({ path: '${step.target || 'screenshot.png'}' });`;
      case 'wait':
        return `  await page.waitForTimeout(${step.value || 1000});`;
      default:
        return `  // Unknown action: ${step.action}`;
    }
  })
  .join('\n')}
});
`.trim();

  return testCode;
}

/**
 * Run inline Playwright script
 */
export async function runPlaywrightScript(
  script: string,
  options: BrowserTestOptions = {}
): Promise<{ success: boolean; output: string; result?: unknown }> {
  const tempDir = '/tmp/playwright-scripts';
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }

  const scriptPath = join(tempDir, `script-${Date.now()}.mjs`);

  // Wrap script with Playwright imports and browser launch
  const wrappedScript = `
import { chromium, firefox, webkit } from 'playwright';

async function run() {
  const browser = await ${options.browser || 'chromium'}.launch({
    headless: ${options.headless !== false},
  });
  const context = await browser.newContext({
    viewport: ${JSON.stringify(options.viewport || { width: 1920, height: 1080 })},
  });
  const page = await context.newPage();

  try {
    ${script}
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
`;

  writeFileSync(scriptPath, wrappedScript);

  return new Promise((resolve) => {
    const proc = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':99',
      },
      timeout: options.timeout || 30000,
    });

    let output = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: err.message,
      });
    });
  });
}

/**
 * Get VNC connection info
 */
export function getVNCInfo(): {
  available: boolean;
  vncUrl?: string;
  noVncUrl?: string;
} {
  const vncEnabled = process.env.VNC_ENABLED !== 'false';
  const vncPort = process.env.VNC_PORT || '5900';
  const noVncPort = process.env.NOVNC_PORT || '6080';
  const hostname = process.env.HOSTNAME || 'localhost';

  return {
    available: vncEnabled,
    vncUrl: vncEnabled ? `vnc://${hostname}:${vncPort}` : undefined,
    noVncUrl: vncEnabled ? `http://${hostname}:${noVncPort}/vnc.html` : undefined,
  };
}
