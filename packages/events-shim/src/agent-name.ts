/**
 * An Agent Relay agent name as a wake link may record it: letters, digits, dots, dashes and
 * underscores, starting with a letter or digit, at most 128 characters (the longest name Agent
 * Relay hosts give an agent). `watch_webhooks` and
 * `link_relay_wake` repeat the name into guidance other sessions read, so free text is never
 * accepted or repeated.
 */
export const WAKE_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * The wake agent name to record or show: `value` trimmed, without a leading `@`, when it is a valid
 * agent name; otherwise undefined. Hosts can apply it before storing `WakeTarget.agent`; the
 * package also applies it to every name it reads back, so a bad stored value is never shown.
 *
 * @param value - The name given to `link_relay_wake`, or a stored `WakeTarget.agent`.
 * @returns The cleaned agent name, or `undefined` when the value is not a valid agent name.
 */
export function wakeAgentName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().replace(/^@/u, '');
  return WAKE_AGENT_NAME_PATTERN.test(name) ? name : undefined;
}
