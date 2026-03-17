'use client';

import { useState } from 'react';

type ChatResponse =
  | { mode: 'chat'; text: string }
  | { mode: 'workflow'; status: string; runId: string };

export default function Page() {
  const [prompt, setPrompt] = useState('Summarize the latest support issue.');
  const [result, setResult] = useState<ChatResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const data = (await response.json()) as ChatResponse;
      setResult(data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>AI SDK + Relay Helpdesk</h1>
      <p>Normal prompts stay in the chat loop. Prompts starting with <code>Please escalate:</code> hand work to a Relay workflow.</p>

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        <textarea
          rows={6}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          style={{ width: '100%' }}
        />
        <button type="submit" disabled={loading}>{loading ? 'Working…' : 'Send'}</button>
      </form>

      {result ? (
        <pre style={{ marginTop: 24, padding: 16, background: '#111', color: '#eee', overflowX: 'auto' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </main>
  );
}
