import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const DEFAULT_SERVICE_NAME = 'agent-relay-events';
const DEFAULT_OTLP_HTTP_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';
const TRACEPARENT_HEADER = 'traceparent';
const TRACESTATE_HEADER = 'tracestate';
const TRACE_PROPAGATOR = new W3CTraceContextPropagator();

interface RuntimeOtelInitOptions {
  enabled?: boolean;
  exporter?: SpanExporter | 'console' | 'otlp-http' | 'none';
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  serviceVersion?: string;
}

type RuntimeOtelState = {
  provider?: NodeTracerProvider;
  tracer: Tracer;
  initialized: boolean;
};

let runtimeOtelState: RuntimeOtelState | null = null;

export function initializeRuntimeOtel(options: RuntimeOtelInitOptions = {}): Tracer {
  if (runtimeOtelState) {
    return runtimeOtelState.tracer;
  }

  const serviceName =
    options.serviceName?.trim() || process.env.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME;
  const serviceVersion = options.serviceVersion?.trim() || process.env.npm_package_version?.trim();
  const enabled = resolveRuntimeOtelEnabled(options.enabled);

  if (!enabled) {
    runtimeOtelState = {
      tracer: trace.getTracer(serviceName),
      initialized: true,
    };
    return runtimeOtelState.tracer;
  }

  const exporter = resolveRuntimeExporter(options);
  const spanProcessors = buildSpanProcessors(exporter);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      ...(serviceVersion ? { [SEMRESATTRS_SERVICE_VERSION]: serviceVersion } : {}),
    }),
    spanProcessors,
  });

  provider.register({
    contextManager: new AsyncLocalStorageContextManager(),
    propagator: TRACE_PROPAGATOR,
  });

  runtimeOtelState = {
    provider,
    tracer: provider.getTracer(serviceName),
    initialized: true,
  };
  return runtimeOtelState.tracer;
}

export function getRuntimeTracer(): Tracer {
  return initializeRuntimeOtel();
}

export async function withRuntimeSpan<T>(
  name: string,
  options: {
    attributes?: Attributes;
    context?: Context;
    kind?: SpanKind;
  },
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = getRuntimeTracer();
  const spanOptions: SpanOptions = {
    kind: options.kind ?? SpanKind.INTERNAL,
    ...(options.attributes ? { attributes: options.attributes } : {}),
  };

  return await tracer.startActiveSpan(
    name,
    spanOptions,
    options.context ?? context.active(),
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

export function injectTraceContextIntoCarrier<T extends Record<string, unknown>>(
  carrier: T,
  sourceContext: Context = context.active()
): T {
  TRACE_PROPAGATOR.inject(sourceContext, carrier, {
    set(target, key, value) {
      target[key] = value;
    },
  });
  return carrier;
}

export function extractTraceContextFromCarrier(carrier: Record<string, unknown> | null | undefined): Context {
  if (!carrier) {
    return ROOT_CONTEXT;
  }

  return TRACE_PROPAGATOR.extract(ROOT_CONTEXT, carrier, {
    get(target, key) {
      const value = target[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
      return undefined;
    },
    keys(target) {
      return Object.keys(target);
    },
  });
}

export function readTraceCarrier(carrier: Record<string, unknown> | null | undefined): {
  traceparent?: string;
  tracestate?: string;
} {
  if (!carrier) {
    return {};
  }

  const traceparent = readString(carrier[TRACEPARENT_HEADER]);
  const tracestate = readString(carrier[TRACESTATE_HEADER]);
  return {
    ...(traceparent ? { traceparent } : {}),
    ...(tracestate ? { tracestate } : {}),
  };
}

export function recordSpanError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    return;
  }

  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: typeof error === 'string' ? error : 'unknown error',
  });
}

export async function resetRuntimeOtelForTests(): Promise<void> {
  if (!runtimeOtelState?.provider) {
    runtimeOtelState = null;
    return;
  }

  await runtimeOtelState.provider.shutdown().catch(() => {});
  runtimeOtelState = null;
}

export async function flushRuntimeOtelForTests(): Promise<void> {
  if (!runtimeOtelState?.provider) {
    return;
  }

  await runtimeOtelState.provider.forceFlush().catch(() => {});
}

function resolveRuntimeOtelEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) {
    return explicit;
  }

  if (isExplicitlyTrue(process.env.OTEL_SDK_DISABLED)) {
    return false;
  }

  if (isExplicitlyTrue(process.env.RELAY_OTEL_ENABLED)) {
    return true;
  }

  if (isExplicitlyFalse(process.env.RELAY_OTEL_ENABLED)) {
    return false;
  }

  return Boolean(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim()
  );
}

function resolveRuntimeExporter(options: RuntimeOtelInitOptions): SpanExporter | null {
  if (options.exporter && typeof options.exporter === 'object' && 'export' in options.exporter) {
    return options.exporter;
  }

  const exporterKind =
    typeof options.exporter === 'string'
      ? options.exporter
      : normalizeExporterKind(process.env.RELAY_OTEL_EXPORTER);

  if (exporterKind === 'none') {
    return null;
  }

  if (exporterKind === 'console') {
    return new ConsoleSpanExporter();
  }

  return new OTLPTraceExporter({
    url:
      options.endpoint?.trim() ||
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      DEFAULT_OTLP_HTTP_ENDPOINT,
    headers:
      options.headers ??
      parseHeaderList(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) ??
      parseHeaderList(process.env.OTEL_EXPORTER_OTLP_HEADERS) ??
      {},
  });
}

function buildSpanProcessors(exporter: SpanExporter | null): SpanProcessor[] {
  if (!exporter) {
    return [];
  }
  return [
    new BatchSpanProcessor(exporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1_000,
      exportTimeoutMillis: 30_000,
    }),
  ];
}

function normalizeExporterKind(value: string | undefined): 'console' | 'none' | 'otlp-http' {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'console') {
    return 'console';
  }
  if (normalized === 'none') {
    return 'none';
  }
  return 'otlp-http';
}

function parseHeaderList(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex < 0) {
        return null;
      }
      const key = entry.slice(0, separatorIndex).trim();
      const headerValue = entry.slice(separatorIndex + 1).trim();
      if (!key || !headerValue) {
        return null;
      }
      return [key, headerValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isExplicitlyTrue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

function isExplicitlyFalse(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(value?.trim() ?? '');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
