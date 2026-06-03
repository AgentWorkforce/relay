import {
  detectOrchestratorHarness,
  initTelemetry,
  track,
  type CommonProperties,
} from '@agent-relay/telemetry';

let initialized = false;
let cachedHarness: string | undefined;

function resolveSdkVersion(): string | undefined {
  const version = process.env.AGENT_RELAY_SDK_VERSION?.trim();
  return version || undefined;
}

function orchestratorHarness(): string {
  cachedHarness ??= detectOrchestratorHarness();
  return cachedHarness;
}

function errorClassName(error: unknown): string | undefined {
  if (error instanceof Error) return error.constructor.name;
  if (error && typeof error === 'object') {
    const ctor = (error as { constructor?: { name?: string } }).constructor;
    return ctor?.name || 'Object';
  }
  return typeof error;
}

export function initSdkTelemetry(): void {
  if (initialized) return;
  initialized = true;
  initTelemetry({
    showNotice: false,
    sdkVersion: resolveSdkVersion(),
    app: 'sdk',
    surface: 'sdk',
    orchestratorHarness: orchestratorHarness(),
  });
}

function sdkCommonOverrides(): Partial<CommonProperties> {
  return {
    app: 'sdk',
    surface: 'sdk',
    orchestrator_harness: orchestratorHarness(),
  };
}

export function trackSdkMethodCall(input: {
  method: string;
  success: boolean;
  durationMs: number;
  error?: unknown;
}): void {
  initSdkTelemetry();
  const errorClass = input.error === undefined ? undefined : errorClassName(input.error);
  track('sdk_method_call', {
    method: input.method,
    success: input.success,
    duration_ms: input.durationMs,
    ...(errorClass ? { error_class: errorClass } : {}),
    ...sdkCommonOverrides(),
  });
}

export function trackSdkWorkflowRun(input: {
  operation: string;
  success: boolean;
  durationMs: number;
  error?: unknown;
}): void {
  initSdkTelemetry();
  const errorClass = input.error === undefined ? undefined : errorClassName(input.error);
  track('sdk_workflow_run', {
    operation: input.operation,
    success: input.success,
    duration_ms: input.durationMs,
    ...(errorClass ? { error_class: errorClass } : {}),
    ...sdkCommonOverrides(),
  });
}

export async function withSdkMethodTelemetry<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    trackSdkMethodCall({ method, success: true, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    trackSdkMethodCall({ method, success: false, durationMs: Date.now() - started, error });
    throw error;
  }
}

export async function withSdkWorkflowTelemetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    trackSdkWorkflowRun({ operation, success: true, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    trackSdkWorkflowRun({ operation, success: false, durationMs: Date.now() - started, error });
    throw error;
  }
}
