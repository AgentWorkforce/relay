import chalk from 'chalk';
import type { ListrTask } from 'listr2';
import type { WorkflowEvent, WorkflowEventListener } from './runner.js';

// Filter console.log while listr owns the terminal.
// Blocks [broker] noise and [workflow HH:MM] timing lines, but lets the
// observer URL and channel name through so users can track the run.
function installOutputFilter(): () => void {
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const str = String(args[0] ?? '');
    // Always show the observer URL and channel so users can follow the run
    if (str.includes('Observer:') || str.includes('agentrelay.dev') || str.includes('Channel: wf-')) {
      orig(...args);
      return;
    }
    // Block [broker] lines and [workflow HH:MM] timing lines
    if (/\[broker\]/.test(str) || /\[workflow\s+\d{2}:\d{2}\]/.test(str)) return;
    orig(...args);
  };
  return () => {
    console.log = orig;
  };
}

interface RenderableTask {
  title: string;
  output: string;
}

interface StepHandle {
  resolve: () => void;
  reject: (error: Error) => void;
  setOutput: (text: string) => void;
  markSkipped: () => void;
}

export interface WorkflowRenderer {
  /** Pass this to `.run({ onEvent })` in your TypeScript workflow. */
  onEvent: WorkflowEventListener;
  /** Start the listr renderer. Run this concurrently with your workflow. */
  start: () => Promise<void>;
  /** Restore console.log after the workflow finishes. */
  unmount: () => void;
}

/**
 * Creates a listr2-based renderer for TypeScript workflows.
 *
 * @example
 * ```typescript
 * import { workflow, createWorkflowRenderer } from '@agent-relay/sdk/workflows';
 *
 * const renderer = createWorkflowRenderer();
 * const [result] = await Promise.all([
 *   workflow('my-workflow').step(...).run({ onEvent: renderer.onEvent }),
 *   renderer.start(),
 * ]);
 * renderer.unmount();
 * ```
 */
export function createWorkflowRenderer(): WorkflowRenderer {
  const stepHandles = new Map<string, StepHandle>();

  let resolveWorkflow!: () => void;
  let rejectWorkflow!: (error: Error) => void;
  const workflowDone = new Promise<void>((resolve, reject) => {
    resolveWorkflow = resolve;
    rejectWorkflow = reject;
  });
  // Prevent unhandled rejection if run:failed fires before the header task
  // reaches `await workflowDone`.
  workflowDone.catch(() => {});

  let setHeader: (text: string) => void = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listr: any = null;
  const pendingAdds: ListrTask[] = [];

  async function ensureListr(): Promise<any> {
    if (listr) return listr;
    const { Listr } = await import('listr2');
    listr = new (Listr as any)(
      [
        {
          title: chalk.dim('Workflow starting...'),
          task: async (_ctx, task): Promise<void> => {
            setHeader = (text: string): void => {
              task.title = text;
            };
            await workflowDone;
          },
        } as ListrTask,
      ],
      {
        concurrent: true,
        renderer: process.stdout.isTTY ? 'default' : 'verbose',
        rendererOptions: {
          collapseErrors: false,
          showErrorMessage: true,
      },
    },
    );
    for (const task of pendingAdds) listr.add(task);
    pendingAdds.length = 0;
    return listr;
  }

  const addTask = (task: ListrTask): void => {
    if (listr) listr.add(task);
    else pendingAdds.push(task);
  };

  const onEvent: WorkflowEventListener = (event: WorkflowEvent) => {
    switch (event.type) {
      case 'run:started': {
        setHeader(chalk.dim(`[workflow] run ${event.runId.slice(0, 8)}...`));
        break;
      }

      case 'step:started': {
        let resolveStep!: () => void;
        let rejectStep!: (error: Error) => void;
        let taskRef: RenderableTask | null = null;
        let skipped = false;

        const done = new Promise<void>((resolve, reject) => {
          resolveStep = resolve;
          rejectStep = reject;
        });
        // Prevent unhandled rejection if the step fails before the listr
        // task function has started and reached `await done`.
        done.catch(() => {});

        stepHandles.set(event.stepName, {
          resolve: resolveStep,
          reject: rejectStep,
          setOutput: (text: string) => {
            if (taskRef) taskRef.output = text;
          },
          markSkipped: () => {
            skipped = true;
            if (taskRef) taskRef.title = chalk.dim(`${event.stepName} (skipped)`);
          },
        });

        addTask({
          title: chalk.white(event.stepName),
          task: async (_ctx, task): Promise<void> => {
            taskRef = task as RenderableTask;
            if (skipped) taskRef.title = chalk.dim(`${event.stepName} (skipped)`);
            await done;
          },
          rendererOptions: { persistentOutput: true },
        } as ListrTask);
        break;
      }

      case 'step:owner-assigned': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.setOutput(
            chalk.dim(`> Owner: ${event.ownerName}`) +
              (event.specialistName ? chalk.dim(` · specialist: ${event.specialistName}`) : ''),
          );
        }
        break;
      }

      case 'step:retrying': {
        stepHandles.get(event.stepName)?.setOutput(chalk.yellow(`Retrying (attempt ${event.attempt})`));
        break;
      }

      case 'step:nudged': {
        stepHandles.get(event.stepName)?.setOutput(chalk.dim(`> Nudge #${event.nudgeCount}`));
        break;
      }

      case 'step:force-released': {
        stepHandles.get(event.stepName)?.setOutput(chalk.yellow('> Force-released'));
        break;
      }

      case 'step:review-completed': {
        stepHandles
          .get(event.stepName)
          ?.setOutput(chalk.dim(`> Review: ${event.decision} by ${event.reviewerName}`));
        break;
      }

      case 'step:owner-timeout': {
        stepHandles
          .get(event.stepName)
          ?.setOutput(chalk.red(`> Owner ${event.ownerName} timed out`));
        break;
      }

      case 'step:completed': {
        stepHandles.get(event.stepName)?.resolve();
        break;
      }

      case 'step:skipped': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.markSkipped();
          handle.resolve();
        } else {
          // Step was skipped without ever being started (downstream of a failure).
          addTask({
            title: chalk.dim(`${event.stepName} (skipped)`),
            task: async (): Promise<void> => {},
            rendererOptions: { persistentOutput: true },
          } as ListrTask);
        }
        break;
      }

      case 'step:failed': {
        stepHandles.get(event.stepName)?.reject(new Error(event.error ?? 'Step failed'));
        break;
      }

      case 'run:completed': {
        setHeader(chalk.green('Workflow completed'));
        resolveWorkflow();
        break;
      }

      case 'run:failed': {
        setHeader(chalk.red(`Workflow failed: ${event.error ?? 'unknown error'}`));
        rejectWorkflow(new Error(event.error ?? 'Workflow failed'));
        break;
      }

      case 'run:cancelled': {
        setHeader(chalk.yellow('Workflow cancelled'));
        resolveWorkflow();
        break;
      }

      case 'broker:event':
        break;

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  };

  let restoreConsole: (() => void) | undefined;

  return {
    onEvent,
    start: async () => {
      restoreConsole = installOutputFilter();
      const l = await ensureListr();
      return l.run().catch(() => {
        // Step failures are already represented in the workflow result.
      });
    },
    unmount: () => {
      restoreConsole?.();
      restoreConsole = undefined;
    },
  };
}
