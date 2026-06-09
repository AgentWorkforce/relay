/**
 * Render an eval report as a self-contained HTML page — open it directly in a
 * browser, no server needed. Shows an overview (harness, metrics), and per
 * scenario the agents + their prompts and the full message transcript (what was
 * sent, by whom, and whether the agent responded).
 */
import type { EvalReport, MatrixReport, MetricSet, ScenarioResult, TranscriptEntry } from '../types.js';

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function shortSha(sha: string): string {
  return sha === 'unknown' ? sha : sha.slice(0, 8);
}

const STYLE = `
:root {
  --bg: #0d1117; --panel: #161b22; --panel2: #1c2330; --line: #2a3340;
  --txt: #e6edf3; --dim: #8b97a6; --accent: #5ab0ff; --green: #3fb950;
  --red: #f85149; --amber: #d29922; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--txt);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { color: var(--dim); font: 12px/1.6 var(--mono); margin-bottom: 24px; }
.sub .badge { color: var(--txt); background: var(--panel2); border: 1px solid var(--line);
  padding: 1px 7px; border-radius: 5px; margin-right: 6px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 28px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card .v { font-size: 24px; font-weight: 650; font-family: var(--mono); letter-spacing: -0.02em; }
.card .l { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
.card.good .v { color: var(--green); } .card.bad .v { color: var(--red); } .card.warn .v { color: var(--amber); }
.scn { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
.scn > header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.scn h2 { font-size: 15px; margin: 0; flex: 1; }
.scn .id { color: var(--dim); font: 11px var(--mono); }
.pill { font: 11px var(--mono); font-weight: 700; padding: 2px 9px; border-radius: 20px; letter-spacing: 0.03em; }
.pill.pass { color: #061a0b; background: var(--green); } .pill.fail { color: #2a0606; background: var(--red); }
.stats { display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 10px 16px; color: var(--dim);
  font: 12px var(--mono); border-bottom: 1px solid var(--line); }
.stats b { color: var(--txt); font-weight: 600; } .stats .x { color: var(--red); }
.body { padding: 12px 16px; }
details { margin-bottom: 12px; } summary { cursor: pointer; color: var(--accent); font-size: 13px; user-select: none; }
.agent { margin: 8px 0 0; }
.agent .nm { font: 12px var(--mono); color: var(--txt); } .agent .role { color: var(--dim); }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px;
  white-space: pre-wrap; word-break: break-word; font: 12px/1.5 var(--mono); color: var(--dim); margin: 4px 0 0; }
.chat { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.msg { max-width: 82%; padding: 8px 12px; border-radius: 12px; }
.msg .meta { font: 10px var(--mono); color: var(--dim); margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.04em; }
.msg .txt { white-space: pre-wrap; word-break: break-word; font-size: 13px; }
.msg.in { align-self: flex-start; background: var(--panel2); border: 1px solid var(--line); border-bottom-left-radius: 3px; }
.msg.out { align-self: flex-end; background: #15324d; border: 1px solid #234a6b; border-bottom-right-radius: 3px; }
.arrow { color: var(--accent); }
.empty { color: var(--dim); font: 12px var(--mono); padding: 6px 0; }
.phantoms { margin-top: 12px; border: 1px solid #5a2526; background: #2a1415; border-radius: 8px; padding: 10px 12px; }
.phantoms .h { color: var(--red); font: 12px var(--mono); font-weight: 700; margin-bottom: 6px; }
.phantoms li { font: 12px var(--mono); color: var(--txt); margin: 3px 0; }
.phantoms .snip { color: var(--dim); }
a { color: var(--accent); }
table { width: 100%; border-collapse: collapse; font: 13px var(--mono); }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 600; font-size: 11px; text-transform: uppercase; }
`;

function metricCards(m: MetricSet): string {
  const cards: Array<{ v: string; l: string; cls?: string }> = [
    { v: pct(m.messageSentRate), l: 'Message-sent rate', cls: m.messageSentRate >= 1 ? 'good' : 'warn' },
    { v: `${pct(m.phantomRate)} (${m.phantomCount})`, l: 'Phantom rate', cls: m.phantomCount > 0 ? 'bad' : 'good' },
    { v: pct(m.protocolAdherence), l: 'Protocol adherence', cls: m.protocolAdherence >= 1 ? 'good' : 'warn' },
    { v: pct(m.deliverySuccessRate), l: 'Delivery success', cls: m.deliverySuccessRate >= 1 ? 'good' : 'bad' },
    { v: String(m.wrongChannelReplies), l: 'Wrong-channel', cls: m.wrongChannelReplies > 0 ? 'bad' : 'good' },
    { v: `${m.scenariosPassed}/${m.scenariosTotal}`, l: 'Scenarios passed', cls: m.scenariosPassed === m.scenariosTotal ? 'good' : 'bad' },
  ];
  return `<div class="cards">${cards
    .map((c) => `<div class="card ${c.cls ?? ''}"><div class="v">${esc(c.v)}</div><div class="l">${esc(c.l)}</div></div>`)
    .join('')}</div>`;
}

function transcriptHtml(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return `<div class="empty">No messages captured.</div>`;
  return `<div class="chat">${entries
    .map((e) => {
      const side = e.fromAgent ? 'out' : 'in';
      const meta = `${esc(e.from)} <span class="arrow">→</span> ${esc(e.target)}${e.threadId ? ` · thread ${esc(e.threadId)}` : ''}`;
      return `<div class="msg ${side}"><div class="meta">${meta}</div><div class="txt">${esc(e.body) || '<em>(empty)</em>'}</div></div>`;
    })
    .join('')}</div>`;
}

function scenarioHtml(s: ScenarioResult): string {
  const stats = [
    `sent <b>${s.sent}/${s.expected}</b>`,
    `phantoms <b class="${s.phantoms.length ? 'x' : ''}">${s.phantoms.length}</b>`,
    s.protocolAdherence !== null ? `protocol <b>${pct(s.protocolAdherence)}</b>` : '',
    `wrong-channel <b class="${s.wrongChannelReplies ? 'x' : ''}">${s.wrongChannelReplies}</b>`,
    `delivery <b>${s.deliveryOk ? 'ok' : 'FAILED'}</b>`,
    s.notes ? `· ${esc(s.notes)}` : '',
  ].filter(Boolean);

  const agents = s.agents.length
    ? `<details><summary>Agents &amp; prompts (${s.agents.length})</summary>${s.agents
        .map(
          (a) =>
            `<div class="agent"><div class="nm">${esc(a.name)} <span class="role">· ${esc(a.cli)}${a.role ? ` · ${esc(a.role)}` : ''}</span></div><pre>${esc(a.prompt)}</pre></div>`
        )
        .join('')}</details>`
    : '';

  const phantoms = s.phantoms.length
    ? `<div class="phantoms"><div class="h">⚠ ${s.phantoms.length} phantom message(s) — intent stated, no tool call</div><ul>${s.phantoms
        .map(
          (p) =>
            `<li>[${esc(p.agent)}] "${esc(p.verb)}${p.target ? ` ${esc(p.target)}` : ''}" — <span class="snip">${esc(p.snippet)}</span></li>`
        )
        .join('')}</ul></div>`
    : '';

  return `<section class="scn">
    <header>
      <span class="pill ${s.pass ? 'pass' : 'fail'}">${s.pass ? 'PASS' : 'FAIL'}</span>
      <h2>${esc(s.title)}</h2>
      <span class="id">${esc(s.id)}</span>
    </header>
    <div class="stats">${stats.join('<span>·</span> ')}</div>
    <div class="body">${agents}${transcriptHtml(s.transcript)}${phantoms}</div>
  </section>`;
}

/** Render one harness report as a full standalone HTML document. */
export function renderReportHtml(report: EvalReport): string {
  const sub = [
    `<span class="badge">${esc(report.harness)}</span>`,
    `git ${esc(shortSha(report.gitSha))}`,
    esc(report.startedAt),
    `${(report.durationMs / 1000).toFixed(1)}s`,
    report.env.repeat > 1 ? `repeat ${report.env.repeat}` : '',
  ].filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Messaging Evals — ${esc(report.harness)}</title><style>${STYLE}</style></head>
<body><div class="wrap">
  <h1>Agent Messaging Evals</h1>
  <div class="sub">${sub.join(' · ')}</div>
  ${metricCards(report.metrics)}
  ${report.scenarios.map(scenarioHtml).join('')}
</div></body></html>`;
}

/** Render the matrix roll-up: one row per harness, linking to its report. */
export function renderMatrixHtml(matrix: MatrixReport, links: Record<string, string>): string {
  const rows = Object.entries(matrix.harnesses)
    .map(([h, m]) => {
      const link = links[h] ? `<a href="${esc(links[h])}">${esc(h)}</a>` : esc(h);
      return `<tr><td>${link}</td><td>${pct(m.messageSentRate)}</td><td class="${m.phantomCount ? '' : ''}">${pct(m.phantomRate)} (${m.phantomCount})</td><td>${pct(m.protocolAdherence)}</td><td>${pct(m.deliverySuccessRate)}</td><td>${m.wrongChannelReplies}</td><td>${m.scenariosPassed}/${m.scenariosTotal}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Messaging Evals — matrix</title><style>${STYLE}</style></head>
<body><div class="wrap">
  <h1>Agent Messaging Evals — harness matrix</h1>
  <div class="sub">git ${esc(shortSha(matrix.gitSha))} · ${esc(matrix.startedAt)}</div>
  <table><thead><tr><th>Harness</th><th>Sent</th><th>Phantom</th><th>Protocol</th><th>Delivery</th><th>Wrong-chan</th><th>Scenarios</th></tr></thead>
  <tbody>${rows}</tbody></table>
</div></body></html>`;
}
