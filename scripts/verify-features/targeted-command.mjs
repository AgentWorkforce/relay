#!/usr/bin/env node

import { constants, accessSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runTargetedProcess } from './targeted-process-runner.mjs';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  return value;
}

function commandExists(command, environment) {
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(path.resolve(command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return String(environment.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        accessSync(path.join(directory, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new Error('targeted command payload is invalid');
  }
  const argv = stringArray(value.argv, 'argv');
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) {
    throw new Error('cwd must be absolute');
  }
  if (!value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)) {
    throw new Error('environment must be an object');
  }
  for (const [name, entry] of Object.entries(value.environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof entry !== 'string') {
      throw new Error(`environment entry ${name} is invalid`);
    }
  }
  if (!Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1) {
    throw new Error('timeoutSeconds must be positive');
  }
  const expectedExitCodes = value.expectedExitCodes;
  if (
    !Array.isArray(expectedExitCodes) ||
    expectedExitCodes.length === 0 ||
    expectedExitCodes.some((code) => !Number.isSafeInteger(code) || code < 0 || code > 255)
  ) {
    throw new Error('expectedExitCodes must contain exit codes from 0 to 255');
  }
  return {
    argv,
    cwd: value.cwd,
    environment: value.environment,
    timeoutSeconds: value.timeoutSeconds,
    requiredCommands: stringArray(value.requiredCommands, 'requiredCommands'),
    requiredEnvironment: stringArray(value.requiredEnvironment, 'requiredEnvironment'),
    expectedExitCodes,
    mustContain: stringArray(value.mustContain, 'mustContain'),
    forbidOutput: stringArray(value.forbidOutput, 'forbidOutput'),
  };
}

async function main() {
  const payload = validatePayload(
    JSON.parse(Buffer.from(requiredOption('--payload'), 'base64url').toString('utf8'))
  );
  const environment = { ...process.env, ...payload.environment };
  const missingEnvironment = payload.requiredEnvironment.filter((name) => !process.env[name]);
  const missingCommands = payload.requiredCommands.filter((command) => !commandExists(command, environment));
  if (missingEnvironment.length > 0 || missingCommands.length > 0) {
    throw new Error(
      [
        missingEnvironment.length ? `missing required environment: ${missingEnvironment.join(', ')}` : '',
        missingCommands.length ? `missing required commands: ${missingCommands.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')
    );
  }

  const result = await runTargetedProcess(payload.argv, {
    cwd: payload.cwd,
    env: environment,
    timeoutMs: payload.timeoutSeconds * 1_000,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.outputLimitExceeded) throw new Error(`command output exceeded ${MAX_OUTPUT_BYTES} bytes`);
  if (result.timedOut) throw new Error(`command timed out after ${payload.timeoutSeconds}s`);
  if (result.aborted) throw new Error('command aborted');

  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const missingText = payload.mustContain.filter((value) => !combined.includes(value));
  const forbiddenText = payload.forbidOutput.filter((value) => combined.includes(value));
  const failures = [
    !payload.expectedExitCodes.includes(result.exitCode)
      ? `exit ${result.exitCode ?? result.signal ?? 'unknown'}; expected ${payload.expectedExitCodes.join(', ')}`
      : '',
    missingText.length > 0 ? `missing output: ${missingText.join(', ')}` : '',
    forbiddenText.length > 0 ? `forbidden output: ${forbiddenText.join(', ')}` : '',
  ].filter(Boolean);
  if (failures.length > 0) throw new Error(failures.join('; '));
  console.log(
    `TARGETED_COMMAND_PASS exit=${result.exitCode} required=${payload.mustContain.length} forbidden=${payload.forbidOutput.length}`
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
