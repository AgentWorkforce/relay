/**
 * API Executor — calls LLM provider APIs directly via fetch().
 * Used when agent cli is 'api'. No sandbox, no CLI, no PTY.
 */

type Provider = 'anthropic' | 'openai' | 'google' | 'openrouter';

function detectProvider(model: string): Provider {
  if (model.startsWith('openrouter/')) return 'openrouter';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return 'openai';
  if (model.startsWith('gemini')) return 'google';
  return 'anthropic';
}

const PROVIDER_ENV: Record<Provider, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

function lookupKey(provider: Provider, envSecrets?: Record<string, string>): string | undefined {
  for (const key of PROVIDER_ENV[provider]) {
    const value = envSecrets?.[key] ?? process.env[key];
    if (value) return value;
  }
  return undefined;
}

function getApiKey(provider: Provider, envSecrets?: Record<string, string>): string {
  const value = lookupKey(provider, envSecrets);
  if (value) return value;
  throw new Error(`No API key for "${provider}". Set ${PROVIDER_ENV[provider].join(' or ')}.`);
}

/**
 * Map a native model ID to its OpenRouter slug. Used as the BYOK fallback
 * path: when a workflow asks for `claude-opus-4` but the user did not supply
 * ANTHROPIC_API_KEY, we route the request through OpenRouter using
 * OPENROUTER_API_KEY (typically the relay-managed default key) and bill the
 * caller for it.
 */
function toOpenRouterSlug(model: string): string | null {
  if (model.startsWith('openrouter/')) return model.replace(/^openrouter\//, '');
  if (model.startsWith('claude')) return `anthropic/${model}`;
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return `openai/${model}`;
  if (model.startsWith('gemini')) return `google/${model}`;
  return null;
}

interface ApiResponse {
  content: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  task: string,
  maxTokens: number,
  systemPrompt?: string
): Promise<ApiResponse> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: task }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    model: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  return {
    content: data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join(''),
    model: data.model,
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens }
      : undefined,
  };
}

async function callOpenAI(
  apiKey: string,
  model: string,
  task: string,
  maxTokens: number,
  systemPrompt?: string
): Promise<ApiResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: task });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    content: data.choices[0]?.message?.content ?? '',
    model: data.model,
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined,
  };
}

async function callGoogle(
  apiKey: string,
  model: string,
  task: string,
  maxTokens: number,
  systemPrompt?: string
): Promise<ApiResponse> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        contents: [{ parts: [{ text: task }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }
  );
  if (!res.ok) throw new Error(`Google API error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };
  return {
    content: data.candidates[0]?.content?.parts?.map((p) => p.text).join('') ?? '',
    model,
    usage: data.usageMetadata
      ? {
          inputTokens: data.usageMetadata.promptTokenCount,
          outputTokens: data.usageMetadata.candidatesTokenCount,
        }
      : undefined,
  };
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  task: string,
  maxTokens: number,
  systemPrompt?: string
): Promise<ApiResponse> {
  // Strip the `openrouter/` prefix used for provider detection; OpenRouter expects the bare slug
  // (e.g. `anthropic/claude-opus-4`, `openai/gpt-4o`, `google/gemini-2.5-pro`).
  const routedModel = model.replace(/^openrouter\//, '');
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: task });
  const referer = process.env.OPENROUTER_HTTP_REFERER ?? 'https://github.com/AgentWorkforce/relay';
  const title = process.env.OPENROUTER_APP_TITLE ?? 'agent-relay';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': referer,
      'X-Title': title,
    },
    body: JSON.stringify({ model: routedModel, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) throw new Error(`OpenRouter API error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  return {
    content: data.choices[0]?.message?.content ?? '',
    model: data.model ?? routedModel,
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined,
  };
}

const PROVIDER_CALLERS = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  google: callGoogle,
  openrouter: callOpenRouter,
} as const;

export interface ApiExecutorOptions {
  envSecrets?: Record<string, string>;
  defaultModel?: string;
  defaultMaxTokens?: number;
  skills?: string;
}

/**
 * Execute a single API call for a workflow step.
 *
 * Key-resolution order (BYOK with relay-managed fallback):
 *   1. If the model is `openrouter/<slug>`, always route through OpenRouter.
 *   2. Otherwise, if the caller supplied the native provider key (e.g.
 *      ANTHROPIC_API_KEY for a `claude-*` model), use that provider directly.
 *   3. Otherwise, if OPENROUTER_API_KEY is available (typically the
 *      relay-managed default when the user has not brought their own key),
 *      rewrite the model to its OpenRouter slug and route through OpenRouter.
 *      Usage is billed against whichever OpenRouter account owns the key.
 *   4. Otherwise, fail with instructions for the native provider AND the
 *      OpenRouter fallback.
 */
export async function executeApiStep(
  model: string,
  task: string,
  options: ApiExecutorOptions = {}
): Promise<string> {
  const resolvedModel = model || options.defaultModel || 'claude-sonnet-4-20250514';
  const maxTokens = options.defaultMaxTokens ?? 4096;
  const provider = detectProvider(resolvedModel);

  // Happy path: explicit OpenRouter request OR native-provider key is present.
  const nativeKey = lookupKey(provider, options.envSecrets);
  if (nativeKey) {
    const response = await PROVIDER_CALLERS[provider](
      nativeKey,
      resolvedModel,
      task,
      maxTokens,
      options.skills
    );
    return response.content;
  }

  // Fallback: route the native model through OpenRouter using the relay-managed key.
  const openRouterKey = lookupKey('openrouter', options.envSecrets);
  if (openRouterKey) {
    const slug = toOpenRouterSlug(resolvedModel);
    if (!slug) {
      throw new Error(
        `No OpenRouter slug mapping for model "${resolvedModel}". Pass a key for the native provider or use an explicit openrouter/<slug> model ID.`
      );
    }
    const response = await callOpenRouter(
      openRouterKey,
      `openrouter/${slug}`,
      task,
      maxTokens,
      options.skills
    );
    return response.content;
  }

  throw new Error(
    `No API key for "${provider}" and no OPENROUTER_API_KEY fallback. ` +
      `Set ${PROVIDER_ENV[provider].join(' or ')} to bring your own key, ` +
      `or set OPENROUTER_API_KEY to bill usage through OpenRouter.`
  );
}

export { detectProvider, getApiKey, toOpenRouterSlug };
