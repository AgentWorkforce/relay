/**
 * API Executor — calls LLM provider APIs directly via fetch().
 * Used when agent cli is 'api'. No sandbox, no CLI, no PTY.
 */

type Provider = 'anthropic' | 'openai' | 'google';

function detectProvider(model: string): Provider {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  return 'anthropic';
}

function getApiKey(provider: Provider, envSecrets?: Record<string, string>): string {
  const envMap: Record<Provider, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  };
  for (const key of envMap[provider]) {
    const value = envSecrets?.[key] ?? process.env[key];
    if (value) return value;
  }
  throw new Error(`No API key for "${provider}". Set ${envMap[provider].join(' or ')}.`);
}

interface ApiResponse {
  content: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

async function callAnthropic(apiKey: string, model: string, task: string, maxTokens: number, systemPrompt?: string): Promise<ApiResponse> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: task }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error (${res.status}): ${await res.text()}`);
  const data = await res.json() as { content: Array<{ type: string; text?: string }>; model: string; usage?: { input_tokens: number; output_tokens: number } };
  return {
    content: data.content.filter(c => c.type === 'text').map(c => c.text ?? '').join(''),
    model: data.model,
    usage: data.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } : undefined,
  };
}

async function callOpenAI(apiKey: string, model: string, task: string, maxTokens: number, systemPrompt?: string): Promise<ApiResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: task });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }>; model: string; usage?: { prompt_tokens: number; completion_tokens: number } };
  return {
    content: data.choices[0]?.message?.content ?? '',
    model: data.model,
    usage: data.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : undefined,
  };
}

async function callGoogle(apiKey: string, model: string, task: string, maxTokens: number, systemPrompt?: string): Promise<ApiResponse> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      contents: [{ parts: [{ text: task }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`Google API error (${res.status}): ${await res.text()}`);
  const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }>; usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number } };
  return {
    content: data.candidates[0]?.content?.parts?.map(p => p.text).join('') ?? '',
    model,
    usage: data.usageMetadata ? { inputTokens: data.usageMetadata.promptTokenCount, outputTokens: data.usageMetadata.candidatesTokenCount } : undefined,
  };
}

const PROVIDER_CALLERS = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle } as const;

export interface ApiExecutorOptions {
  envSecrets?: Record<string, string>;
  defaultModel?: string;
  defaultMaxTokens?: number;
  skills?: string;
}

export async function executeApiStep(model: string, task: string, options: ApiExecutorOptions = {}): Promise<string> {
  const resolvedModel = model || options.defaultModel || 'claude-sonnet-4-20250514';
  const maxTokens = options.defaultMaxTokens ?? 4096;
  const provider = detectProvider(resolvedModel);
  const apiKey = getApiKey(provider, options.envSecrets);
  const response = await PROVIDER_CALLERS[provider](apiKey, resolvedModel, task, maxTokens, options.skills);
  return response.content;
}

export { detectProvider, getApiKey };
