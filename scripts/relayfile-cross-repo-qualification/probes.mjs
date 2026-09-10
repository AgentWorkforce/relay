import { execFile } from 'node:child_process';

const defaultExecFile = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
    // Codex otherwise keeps waiting for an optional stdin prompt when execFile
    // gives it a pipe. The probe contract supplies the complete prompt in argv.
    child.stdin?.end();
  });
export const PROBE_TIMEOUT_MS = 30_000;
export const PROBE_KILL_SIGNAL = 'SIGKILL';
export const PROBES = [
  {
    name: 'codex',
    model: 'gpt-5.6-luna',
    command: 'codex',
    args: [
      'exec',
      '--ephemeral',
      '--json',
      '--sandbox',
      'read-only',
      '--ignore-rules',
      '-m',
      'gpt-5.6-luna',
      'Respond with exactly RELAYFILE_CODEX_PROBE_OK and do not use tools.',
    ],
    token: 'RELAYFILE_CODEX_PROBE_OK',
    json: true,
  },
  {
    name: 'claude',
    model: 'sonnet',
    command: 'claude',
    args: [
      '-p',
      '--model',
      'sonnet',
      '--permission-mode',
      'plan',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      '',
      '--tools',
      '',
      '--system-prompt',
      'Return only the exact requested token.',
      'RELAYFILE_CLAUDE_PROBE_OK',
    ],
    token: 'RELAYFILE_CLAUDE_PROBE_OK',
    json: false,
  },
];

function jsonProbeTexts(stdout) {
  const texts = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return undefined;
    }
    const item = value?.item;
    if (item?.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text);
    else if (value?.type === 'message' && typeof value.text === 'string') texts.push(value.text);
  }
  return texts;
}

/** Require the complete response token, rejecting extra model output. */
export function hasExactProbeToken(stdout, token, json = false) {
  if (typeof stdout !== 'string' || typeof token !== 'string') return false;
  if (!json) return stdout.trim() === token;
  const texts = jsonProbeTexts(stdout);
  return Array.isArray(texts) && texts.length === 1 && texts[0] === token;
}

export function redactProbeEvidence(value) {
  return String(value ?? '')
    .replace(/(authorization|api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .slice(0, 240);
}

export async function runProbe(
  probe,
  { execFileAsync = defaultExecFile, timeoutMs = PROBE_TIMEOUT_MS } = {}
) {
  const options = {
    timeout: timeoutMs,
    killSignal: PROBE_KILL_SIGNAL,
    maxBuffer: 1_048_576,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  try {
    const result = await execFileAsync(probe.command, probe.args, options);
    const ok = hasExactProbeToken(result.stdout, probe.token, probe.json);
    return ok
      ? { name: probe.name, ok: true }
      : {
          name: probe.name,
          ok: false,
          failure: `${probe.name} probe returned unexpected output: ${redactProbeEvidence(result.stdout)}`,
        };
  } catch (error) {
    return {
      name: probe.name,
      ok: false,
      failure: `${probe.name} probe failed (code=${redactProbeEvidence(error?.code)}, signal=${redactProbeEvidence(error?.signal)}): ${redactProbeEvidence(error?.stderr || error?.stdout || error?.message)}`,
    };
  }
}
