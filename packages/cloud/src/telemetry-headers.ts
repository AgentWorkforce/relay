export const AGENT_RELAY_DISTINCT_ID_HEADER = 'X-Agent-Relay-Distinct-Id';
export const RELAYCAST_HARNESS_HEADER = 'X-Relaycast-Harness';
export const RELAYCAST_ORIGIN_SURFACE_HEADER = 'X-Relaycast-Origin-Surface';
export const RELAYCAST_ORIGIN_CLIENT_HEADER = 'X-Relaycast-Origin-Client';
export const RELAYCAST_ORIGIN_VERSION_HEADER = 'X-Relaycast-Origin-Version';

const AGENT_RELAY_DISTINCT_ID_ENV = 'AGENT_RELAY_DISTINCT_ID';
const ORCHESTRATOR_HARNESS_ENV = 'AGENT_RELAY_ORCHESTRATOR_HARNESS';
const TELEMETRY_SURFACE_ENV = 'AGENT_RELAY_TELEMETRY_SURFACE';
const TELEMETRY_CLIENT_ENV = 'AGENT_RELAY_TELEMETRY_CLIENT';

const DISTINCT_ID_ALLOWED = /^[a-z0-9._:-]+$/i;
const HEADER_VALUE_ALLOWED = /^[a-z0-9 ._\-/():=;,+@]+$/i;

function sanitizeHeaderValue(
  raw: string | undefined,
  options: { maxLength: number; pattern?: RegExp }
): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (options.pattern && !options.pattern.test(trimmed)) return undefined;
  return trimmed.slice(0, options.maxLength);
}

function isTelemetryDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.AGENT_RELAY_TELEMETRY_DISABLED ?? env.DO_NOT_TRACK;
  return disabled === '1' || disabled?.toLowerCase() === 'true';
}

export function buildAgentRelayTelemetryHeaders(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (isTelemetryDisabledByEnv(env)) return {};

  const distinctId = sanitizeHeaderValue(env[AGENT_RELAY_DISTINCT_ID_ENV], {
    maxLength: 128,
    pattern: DISTINCT_ID_ALLOWED,
  });
  if (!distinctId) return {};

  const headers: Record<string, string> = {
    [AGENT_RELAY_DISTINCT_ID_HEADER]: distinctId,
  };

  const harness = sanitizeHeaderValue(env[ORCHESTRATOR_HARNESS_ENV], {
    maxLength: 120,
    pattern: HEADER_VALUE_ALLOWED,
  });
  const surface = sanitizeHeaderValue(env[TELEMETRY_SURFACE_ENV], {
    maxLength: 32,
    pattern: HEADER_VALUE_ALLOWED,
  });
  const client = sanitizeHeaderValue(env[TELEMETRY_CLIENT_ENV], {
    maxLength: 80,
    pattern: HEADER_VALUE_ALLOWED,
  });
  const version = sanitizeHeaderValue(env.AGENT_RELAY_CLI_VERSION ?? env.AGENT_RELAY_SDK_VERSION, {
    maxLength: 48,
    pattern: HEADER_VALUE_ALLOWED,
  });

  if (harness) headers[RELAYCAST_HARNESS_HEADER] = harness;
  if (surface) headers[RELAYCAST_ORIGIN_SURFACE_HEADER] = surface;
  if (client) headers[RELAYCAST_ORIGIN_CLIENT_HEADER] = client;
  if (version) headers[RELAYCAST_ORIGIN_VERSION_HEADER] = version;

  return headers;
}

export function appendAgentRelayTelemetryHeaders(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env
): Headers {
  for (const [name, value] of Object.entries(buildAgentRelayTelemetryHeaders(env))) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return headers;
}
