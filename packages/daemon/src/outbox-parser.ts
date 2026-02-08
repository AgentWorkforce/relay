/**
 * Outbox file parser — shared by Connector and HostedRunner.
 *
 * Parses the header-format outbox files that agents write via the
 * file-based protocol (->relay-file:msg, ->relay-file:spawn, etc.).
 */

/**
 * Parsed result from an outbox file.
 */
export interface ParsedOutboxFile {
  to?: string;
  kind?: string;
  name?: string;
  cli?: string;
  thread?: string;
  action?: string;
  body: string;
}

/**
 * Parse a header-format outbox file.
 *
 * Format:
 *   TO: AgentName
 *   KIND: message|spawn|release
 *   THREAD: optional-thread
 *
 *   Body content here
 *
 * Falls back to JSON parsing if no recognized headers are found.
 */
export function parseOutboxFile(content: string): ParsedOutboxFile | null {
  // Split at first blank line
  const blankLineIdx = content.indexOf('\n\n');
  let headerSection: string;
  let body: string;

  if (blankLineIdx === -1) {
    // No blank line — treat entire content as headers (no body)
    headerSection = content;
    body = '';
  } else {
    headerSection = content.substring(0, blankLineIdx);
    body = content.substring(blankLineIdx + 2);
  }

  const headers: Record<string, string> = {};
  for (const line of headerSection.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toUpperCase();
    const value = line.substring(colonIdx + 1).trim();
    if (key && value) {
      headers[key] = value;
    }
  }

  // Must have TO or KIND header to be valid
  if (!headers['TO'] && !headers['KIND']) {
    // Try JSON fallback
    try {
      const json = JSON.parse(content);
      return {
        to: json.to,
        kind: json.kind ?? 'message',
        name: json.name,
        cli: json.cli,
        thread: json.thread,
        body: json.body ?? '',
      };
    } catch {
      return null;
    }
  }

  return {
    to: headers['TO'],
    kind: headers['KIND'] ?? 'message',
    name: headers['NAME'],
    cli: headers['CLI'],
    thread: headers['THREAD'],
    action: headers['ACTION'],
    body: body.trim(),
  };
}
