export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface StructuredLogEntry {
  ts: string;
  level: LogLevel;
  workspace: string;
  agentId: string;
  eventId?: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type CreateLoggerOptions = {
  workspace: string;
  agentId: string;
  level?: LogLevel;
  sink?: (entry: StructuredLogEntry) => void;
  console?: Pick<Console, 'debug' | 'info' | 'warn' | 'error' | 'log'>;
};

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const RESERVED_FIELDS = new Set(['ts', 'level', 'workspace', 'agentId', 'eventId', 'msg']);

export function createLogger(options: CreateLoggerOptions): Logger {
  const threshold = normalizeLogLevel(options.level);
  const consoleTarget = options.console ?? console;

  const emit = (level: LogLevel, message: string, fields?: LogFields) => {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[threshold]) {
      return;
    }

    const entry = toStructuredLogEntry(
      {
        workspace: options.workspace,
        agentId: options.agentId,
      },
      level,
      message,
      fields
    );
    const payload = JSON.stringify(entry);

    options.sink?.(entry);

    switch (level) {
      case 'debug':
        consoleTarget.debug(payload);
        return;
      case 'info':
        consoleTarget.info(payload);
        return;
      case 'warn':
        consoleTarget.warn(payload);
        return;
      case 'error':
        consoleTarget.error(payload);
        return;
      default:
        consoleTarget.log(payload);
    }
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export function bindLogger(logger: Logger, boundFields: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields =>
    fields ? { ...boundFields, ...fields } : { ...boundFields };

  return {
    debug: (message, fields) => logger.debug(message, merge(fields)),
    info: (message, fields) => logger.info(message, merge(fields)),
    warn: (message, fields) => logger.warn(message, merge(fields)),
    error: (message, fields) => logger.error(message, merge(fields)),
  };
}

export function normalizeLogLevel(level?: string | null): LogLevel {
  switch (level?.trim().toLowerCase()) {
    case 'debug':
      return 'debug';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    case 'info':
    default:
      return 'info';
  }
}

function toStructuredLogEntry(
  base: Pick<StructuredLogEntry, 'workspace' | 'agentId'>,
  level: LogLevel,
  message: string,
  fields?: LogFields
): StructuredLogEntry {
  const extras = sanitizeLogFields(fields);
  const eventId =
    typeof fields?.eventId === 'string' && fields.eventId.trim() ? fields.eventId.trim() : undefined;
  return {
    ts: new Date().toISOString(),
    level,
    workspace: base.workspace,
    agentId: base.agentId,
    ...(eventId ? { eventId } : {}),
    msg: message,
    ...extras,
  };
}

function sanitizeLogFields(fields?: LogFields): LogFields {
  if (!fields) {
    return {};
  }

  const sanitized: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
