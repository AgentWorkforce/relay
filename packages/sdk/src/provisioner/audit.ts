import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PermissionAuditEntry {
  timestamp: string;
  agentName: string;
  action: string;
  details: Record<string, unknown>;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const DEFAULT_PERMISSION_AUDIT_RELATIVE_PATH = path.join('.agent-relay', 'permission-audit.json');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeJsonValue(value: unknown, key?: string): JsonValue {
  if (key && key.toLowerCase().includes('token')) {
    return '[redacted]';
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeJsonValue(entryValue, entryKey),
      ])
    );
  }

  return String(value);
}

export function getDefaultPermissionAuditPath(projectDir: string): string {
  return path.resolve(projectDir, DEFAULT_PERMISSION_AUDIT_RELATIVE_PATH);
}

export class PermissionAuditLog {
  private readonly entries: PermissionAuditEntry[] = [];

  log(entry: Omit<PermissionAuditEntry, 'timestamp'> & { timestamp?: string }): PermissionAuditEntry {
    const storedEntry: PermissionAuditEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      agentName: entry.agentName,
      action: entry.action,
      details: sanitizeJsonValue(entry.details) as Record<string, unknown>,
    };

    this.entries.push(storedEntry);
    return storedEntry;
  }

  toJSON(): { entries: PermissionAuditEntry[] } {
    return {
      entries: this.entries.map((entry) => ({
        timestamp: entry.timestamp,
        agentName: entry.agentName,
        action: entry.action,
        details: { ...entry.details },
      })),
    };
  }

  async writeTo(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
  }

  summary(): string {
    if (this.entries.length === 0) {
      return 'Permission audit: 0 entries';
    }

    const actionCounts = new Map<string, number>();
    const agentNames = new Set<string>();

    for (const entry of this.entries) {
      actionCounts.set(entry.action, (actionCounts.get(entry.action) ?? 0) + 1);
      agentNames.add(entry.agentName);
    }

    const actionSummary = [...actionCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([action, count]) => `${action}=${count}`)
      .join(', ');

    return `Permission audit: ${this.entries.length} entr${this.entries.length === 1 ? 'y' : 'ies'} across ${agentNames.size} agent${agentNames.size === 1 ? '' : 's'} (${actionSummary})`;
  }
}
