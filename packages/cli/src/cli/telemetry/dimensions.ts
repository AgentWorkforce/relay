/** Cross-client reporting labels; never forward custom harness strings here. */
export function telemetryClient(
  harness: unknown
): 'cursor' | 'chatgpt' | 'claude' | 'muse' | 'codex' | 'grok' | 'unknown' {
  switch (harness) {
    case 'claude-code':
      return 'claude';
    case 'cursor':
    case 'chatgpt':
    case 'muse':
    case 'codex':
    case 'grok':
      return harness;
    default:
      return 'unknown';
  }
}

export function telemetryOs(
  platform: unknown
): 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown' {
  switch (platform) {
    case 'darwin':
    case 'macos':
      return 'macos';
    case 'win32':
    case 'windows':
      return 'windows';
    case 'linux':
    case 'ios':
    case 'android':
      return platform;
    default:
      return 'unknown';
  }
}
