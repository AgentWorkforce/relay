import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface CodexOAuthTokens {
  access_token: string;
  refresh_token?: string;
}

export interface CodexAuth {
  tokens?: CodexOAuthTokens;
  OPENAI_API_KEY?: string;
}

export interface ConvertResult {
  /** Whether auth was written. */
  ok: boolean;
  /** Provider hint derived from auth source (e.g. 'openai-codex' for OAuth). */
  preferredProvider: string;
}

/**
 * Convert Codex CLI auth.json into OpenClaw's legacy auth format.
 *
 * Reads ~/.codex/auth.json (or codexAuthPath) and writes the converted
 * auth to ~/.openclaw/agents/main/agent/auth.json (or openclawAuthDir).
 *
 * Falls back to OPENAI_API_KEY env var if no codex auth file exists.
 */
export async function convertCodexAuth(options?: {
  codexAuthPath?: string;
  openclawAuthDir?: string;
  openaiApiKey?: string;
}): Promise<ConvertResult> {
  const home = process.env.HOME ?? '/home/node';
  const codexPath = options?.codexAuthPath ?? join(home, '.codex', 'auth.json');
  const openclawAgentDir = options?.openclawAuthDir ?? join(home, '.openclaw', 'agents', 'main', 'agent');
  const openclawAuthPath = join(openclawAgentDir, 'auth.json');
  let preferredProvider = 'openai';

  if (existsSync(codexPath)) {
    const codex: CodexAuth = JSON.parse(await readFile(codexPath, 'utf8'));
    await mkdir(openclawAgentDir, { recursive: true });

    if (codex.tokens?.access_token) {
      // OAuth tokens from codex subscription
      const auth = {
        'openai-codex': {
          type: 'oauth',
          provider: 'openai-codex',
          access: codex.tokens.access_token,
          refresh: codex.tokens.refresh_token ?? '',
          expires: Date.now() + 3600000,
        },
      };
      await writeFile(openclawAuthPath, JSON.stringify(auth, null, 2), 'utf8');
      preferredProvider = 'openai-codex';
      return { ok: true, preferredProvider };
    }

    if (codex.OPENAI_API_KEY && typeof codex.OPENAI_API_KEY === 'string') {
      const auth = {
        openai: {
          type: 'api_key',
          provider: 'openai',
          key: codex.OPENAI_API_KEY,
        },
      };
      await writeFile(openclawAuthPath, JSON.stringify(auth, null, 2), 'utf8');
      return { ok: true, preferredProvider };
    }
  }

  // Fallback: use OPENAI_API_KEY from env
  const envKey = options?.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (envKey) {
    await mkdir(openclawAgentDir, { recursive: true });
    const auth = {
      openai: {
        type: 'api_key',
        provider: 'openai',
        key: envKey,
      },
    };
    await writeFile(openclawAuthPath, JSON.stringify(auth, null, 2), 'utf8');
    return { ok: true, preferredProvider };
  }

  return { ok: false, preferredProvider };
}
