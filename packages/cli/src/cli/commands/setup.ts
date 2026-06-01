import { Command } from 'commander';
import { enableTelemetry, disableTelemetry, getStatus, isDisabledByEnv } from '@agent-relay/telemetry';
import { defaultExit } from '../lib/exit.js';

type ExitFn = (code: number) => never;

export interface SetupDependencies {
  runTelemetry: (action?: string) => Promise<void> | void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

interface SetupIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<SetupDependencies> = {}): SetupDependencies {
  const log = overrides.log ?? ((...args: unknown[]) => console.log(...args));
  const error = overrides.error ?? ((...args: unknown[]) => console.error(...args));
  const exit = overrides.exit ?? defaultExit;
  const io: SetupIo = { log, error, exit };
  return {
    runTelemetry: overrides.runTelemetry ?? ((action?: string) => runTelemetryDefault(action, io)),
    log,
    error,
    exit,
    ...overrides,
  };
}

function runTelemetryDefault(action: string | undefined, io: SetupIo): void {
  if (action === 'enable') {
    if (isDisabledByEnv()) {
      io.log('Cannot enable: AGENT_RELAY_TELEMETRY_DISABLED or DO_NOT_TRACK is set');
      io.log('Remove the environment variable to enable telemetry.');
      return;
    }
    enableTelemetry();
    io.log('Telemetry enabled');
    io.log('Anonymous usage data will be collected to improve Agent Relay.');
    return;
  }
  if (action === 'disable') {
    disableTelemetry();
    io.log('Telemetry disabled');
    io.log('No usage data will be collected.');
    return;
  }
  const status = getStatus();
  io.log('Telemetry Status');
  io.log('================');
  io.log(`Enabled: ${status.enabled ? 'Yes' : 'No'}`);
  if (status.disabledByEnv) {
    io.log('(Disabled via AGENT_RELAY_TELEMETRY_DISABLED or DO_NOT_TRACK environment variable)');
  }
  io.log(`Anonymous ID: ${status.anonymousId}`);
  if (status.notifiedAt) {
    io.log(`First run notice shown: ${new Date(status.notifiedAt).toLocaleString()}`);
  }
  io.log('');
  io.log('Commands:');
  io.log('  agent-relay telemetry enable   - Opt in to telemetry');
  io.log('  agent-relay telemetry disable  - Opt out of telemetry');
  io.log('');
  io.log('Learn more: https://agentrelay.com/telemetry');
}

export function registerSetupCommands(program: Command, overrides: Partial<SetupDependencies> = {}): void {
  const deps = withDefaults(overrides);
  program
    .command('telemetry')
    .description('Manage anonymous telemetry (enable/disable/status)')
    .argument('[action]', 'Action: enable, disable, or status (default: status)')
    .action(async (action?: string) => {
      await deps.runTelemetry(action);
    });
}
