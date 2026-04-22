import { WorkflowRunner, type RelayYamlConfig } from '@agent-relay/sdk/workflows';

import { BrowserStepExecutor, createBrowserStep } from '../src/workflow-step.js';

const browserExecutor = new BrowserStepExecutor();

const config: RelayYamlConfig = {
  version: '1.0',
  name: 'browser-primitive-workflow',
  description: 'Browser primitive workflow with chained actions and captured output.',
  swarm: {
    pattern: 'pipeline',
  },
  agents: [],
  workflows: [
    {
      name: 'browser-primitive-workflow',
      steps: [
        createBrowserStep({
          name: 'inspect-example-page',
          sessionId: 'example-page-session',
          config: {
            browser: 'chromium',
            headless: true,
            viewport: { width: 1280, height: 720 },
            captureConsole: true,
            persistSession: true,
          },
          actions: [
            {
              action: 'goto',
              params: {
                url: 'https://example.com',
                waitUntil: 'domcontentloaded',
              },
            },
            {
              action: 'text',
              id: 'heading',
              params: {
                selector: 'h1',
                innerText: true,
              },
            },
          ],
          output: {
            mode: 'last',
            format: 'text',
          },
        }),
        createBrowserStep({
          name: 'use-captured-heading',
          dependsOn: ['inspect-example-page'],
          sessionId: 'example-page-session',
          config: {
            browser: 'chromium',
            headless: true,
            persistSession: true,
          },
          actions: [
            {
              action: 'evaluate',
              params: {
                script: '() => `Current title from the persisted session: ${document.title}`',
              },
            },
          ],
          output: {
            mode: 'last',
            format: 'text',
          },
        }),
        createBrowserStep({
          name: 'capture-page-report',
          dependsOn: ['use-captured-heading'],
          sessionId: 'example-page-session',
          config: {
            browser: 'chromium',
            headless: true,
            persistSession: true,
          },
          actions: [
            {
              action: 'evaluate',
              id: 'pageFacts',
              outputKey: 'pageFacts',
              capture: true,
              params: {
                script: '() => ({ title: document.title, links: document.links.length })',
              },
            },
            {
              action: 'screenshot',
              id: 'screenshot',
              outputKey: 'screenshot',
              capture: true,
              params: {
                path: 'artifacts/example-page.png',
                fullPage: true,
              },
            },
          ],
          output: {
            mode: 'captures',
            includeMetadata: true,
            includeSession: true,
            pretty: true,
          },
          closeSession: true,
        }),
      ],
    },
  ],
  errorHandling: {
    strategy: 'fail-fast',
  },
};

async function main(): Promise<void> {
  const runner = new WorkflowRunner({
    cwd: process.cwd(),
    executor: browserExecutor,
  });

  const result = await runner.execute(config);
  console.log(`Browser workflow completed: ${result.status}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await browserExecutor.closeAll();
    });
}
