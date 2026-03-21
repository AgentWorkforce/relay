'use client';

import { useState } from 'react';

import s from './sdk-code.module.css';

const TS_CODE = `import { AgentRelay } from "@agent-relay/sdk";

const relay = new AgentRelay({ channels: ["quantum-error-correction"] });

await relay.claude.spawn({
  name: "Research",
  task: "Discuss quantum error correction approaches with Build.",
});

await relay.codex.spawn({
  name: "Build",
  task: "Debate implementation strategies with Research.",
});

const director = relay.human({ name: "Director" });
await director.sendMessage({
  to: "quantum-error-correction",
  text: "Discuss and report back with solutions you both agree on.",
});`;

const PY_CODE = `from agent_relay import AgentRelay

relay = AgentRelay(channels=["quantum-error-correction"])

await relay.claude.spawn(
    name="Research",
    task="Discuss quantum error correction approaches with Build.",
)

await relay.codex.spawn(
    name="Build",
    task="Debate implementation strategies with Research.",
)

director = relay.human(name="Director")
await director.send_message(
    to="quantum-error-correction",
    text="Discuss and report back with solutions you both agree on.",
)`;

type Tab = 'typescript' | 'python';

function highlight(code: string, lang: Tab) {
  // Simple syntax highlighting via spans
  const keywords = lang === 'typescript'
    ? /\b(import|from|const|await|new)\b/g
    : /\b(from|import|await)\b/g;

  const methods = /\.(\w+)\(/g;
  const types = lang === 'typescript'
    ? /\b(AgentRelay)\b/g
    : /\b(AgentRelay)\b/g;

  // Process in stages to avoid overlapping
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Replace strings first (capture them)
  const parts: string[] = [];
  let lastIdx = 0;
  const stringMatches = [...escaped.matchAll(/(["'`])(?:(?!\1).)*\1/g)];

  if (stringMatches.length === 0) {
    return highlightNonString(escaped, keywords, methods, types);
  }

  for (const m of stringMatches) {
    const before = escaped.slice(lastIdx, m.index);
    parts.push(highlightNonString(before, keywords, methods, types));
    parts.push(`<span class="${s.string}">${m[0]}</span>`);
    lastIdx = m.index! + m[0].length;
  }
  parts.push(highlightNonString(escaped.slice(lastIdx), keywords, methods, types));

  return parts.join('');
}

function highlightNonString(
  text: string,
  keywords: RegExp,
  methods: RegExp,
  types: RegExp
): string {
  return text
    .replace(types, `<span class="${s.type}">$1</span>`)
    .replace(keywords, `<span class="${s.keyword}">$&</span>`)
    .replace(methods, `.<span class="${s.method}">$1</span>(`);
}

export function SdkCodeExample() {
  const [tab, setTab] = useState<Tab>('typescript');

  const code = tab === 'typescript' ? TS_CODE : PY_CODE;

  return (
    <div className={s.codeBlock}>
      <div className={s.tabs}>
        <button
          className={`${s.tab} ${tab === 'typescript' ? s.tabActive : ''}`}
          onClick={() => setTab('typescript')}
        >
          TypeScript
        </button>
        <button
          className={`${s.tab} ${tab === 'python' ? s.tabActive : ''}`}
          onClick={() => setTab('python')}
        >
          Python
        </button>
      </div>
      <pre className={s.pre}>
        <code dangerouslySetInnerHTML={{ __html: highlight(code, tab) }} />
      </pre>
    </div>
  );
}
