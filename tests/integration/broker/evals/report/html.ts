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

function pctNum(x: number): number {
  return Math.round(x * 100);
}

function shortSha(sha: string): string {
  return sha === 'unknown' ? sha : sha.slice(0, 8);
}

/** Returns a CSS class name for a 0-1 metric value. */
function rateClass(v: number): string {
  if (v >= 0.8) return 'good';
  if (v >= 0.5) return 'warn';
  return 'bad';
}

/** Returns a CSS class for a raw count where zero is good. */
function countClass(n: number): string {
  return n === 0 ? 'good' : 'bad';
}

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------

const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700&display=swap');

:root {
  --bg: #0d1117;
  --canvas: #010409;
  --panel: #161b22;
  --panel2: #1c2330;
  --panel3: #21262d;
  --line: #30363d;
  --line2: #21262d;
  --txt: #e6edf3;
  --txt2: #c9d1d9;
  --dim: #8b949e;
  --dim2: #6e7681;
  --accent: #388bfd;
  --accent-subtle: #1f3557;
  --green: #3fb950;
  --green-subtle: #1a3a24;
  --green-border: #2ea043;
  --red: #f85149;
  --red-subtle: #3a1a1a;
  --red-border: #da3633;
  --amber: #d29922;
  --amber-subtle: #3a2a10;
  --amber-border: #9e6a03;
  --blue: #58a6ff;
  --purple: #bc8cff;
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html { scroll-behavior: smooth; }

body {
  background: var(--bg);
  color: var(--txt);
  font: 14px/1.6 var(--sans);
  min-height: 100vh;
}

/* ---- layout ---- */
.wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 100px; }

/* ---- page header ---- */
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 32px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--line);
}
.page-header-left { flex: 1; }
.page-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--txt);
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-title .icon {
  width: 28px; height: 28px;
  background: linear-gradient(135deg, #388bfd 0%, #bc8cff 100%);
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.page-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
  align-items: center;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: 500 11px/1 var(--mono);
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--panel2);
  color: var(--txt2);
  white-space: nowrap;
}
.badge.harness {
  background: var(--accent-subtle);
  border-color: var(--accent);
  color: var(--blue);
}
.badge.sha { color: var(--purple); border-color: #4a3a6b; background: #1a1030; }
.meta-dot { color: var(--dim2); font-size: 11px; }

/* ---- pass/fail summary pill ---- */
.summary-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 10px;
  font: 600 13px var(--sans);
  border: 1px solid;
  white-space: nowrap;
}
.summary-pill.all-pass { background: var(--green-subtle); border-color: var(--green-border); color: var(--green); }
.summary-pill.has-fail  { background: var(--red-subtle);   border-color: var(--red-border);   color: var(--red); }

/* ---- metric cards ---- */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
  margin-bottom: 32px;
}
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 16px;
  position: relative;
  overflow: hidden;
  transition: border-color 0.15s;
}
.card::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  border-radius: 10px 10px 0 0;
}
.card.good::after { background: var(--green); }
.card.warn::after { background: var(--amber); }
.card.bad::after  { background: var(--red); }
.card .v {
  font: 700 26px/1 var(--mono);
  letter-spacing: -0.03em;
  margin-bottom: 6px;
}
.card.good .v { color: var(--green); }
.card.warn .v { color: var(--amber); }
.card.bad  .v { color: var(--red); }
.card .l {
  font: 500 10px/1.4 var(--sans);
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ---- section headers ---- */
.section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 36px 0 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line2);
}
.section-header h2 {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--txt);
}
.section-header .count {
  font: 500 11px var(--mono);
  color: var(--dim);
  background: var(--panel2);
  border: 1px solid var(--line);
  padding: 1px 7px;
  border-radius: 20px;
}
.section-icon {
  width: 20px; height: 20px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  flex-shrink: 0;
}
.section-icon.lifecycle { background: #1a3a24; color: var(--green); }
.section-icon.messaging  { background: var(--accent-subtle); color: var(--blue); }

/* ---- variant breakdown table (per-report) ---- */
.variant-section {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  margin-bottom: 20px;
  overflow: hidden;
}
.variant-section .vs-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  font: 600 12px var(--sans);
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background: var(--panel2);
}
.variant-table {
  width: 100%;
  border-collapse: collapse;
  font: 13px var(--sans);
}
.variant-table th {
  padding: 8px 14px;
  text-align: left;
  font: 500 11px var(--sans);
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--line2);
  background: var(--panel2);
}
.variant-table td {
  padding: 9px 14px;
  border-bottom: 1px solid var(--line2);
  vertical-align: middle;
}
.variant-table tr:last-child td { border-bottom: none; }
.variant-table .variant-name {
  font: 500 13px var(--mono);
  color: var(--txt2);
}
.rate-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rate-bar-track {
  flex: 1;
  max-width: 80px;
  height: 4px;
  background: var(--line);
  border-radius: 2px;
  overflow: hidden;
}
.rate-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s;
}
.rate-bar-fill.good { background: var(--green); }
.rate-bar-fill.warn { background: var(--amber); }
.rate-bar-fill.bad  { background: var(--red); }
.rate-num { font: 600 12px var(--mono); min-width: 38px; }
.rate-num.good { color: var(--green); }
.rate-num.warn { color: var(--amber); }
.rate-num.bad  { color: var(--red); }

/* ---- lifecycle summary table ---- */
.lifecycle-summary {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  margin-bottom: 20px;
  overflow: hidden;
}
.lifecycle-summary .ls-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  font: 600 12px var(--sans);
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background: var(--panel2);
}
.lc-table {
  width: 100%;
  border-collapse: collapse;
  font: 13px var(--sans);
}
.lc-table th {
  padding: 8px 14px;
  text-align: left;
  font: 500 11px var(--sans);
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--line2);
  background: var(--panel2);
}
.lc-table td {
  padding: 9px 14px;
  border-bottom: 1px solid var(--line2);
  vertical-align: middle;
}
.lc-table tr:last-child td { border-bottom: none; }

/* ---- scenario cards ---- */
.scn {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  margin-bottom: 12px;
  overflow: hidden;
  transition: border-color 0.15s;
}
.scn:hover { border-color: #444c56; }
.scn > .scn-header {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.scn h3 {
  font: 600 14px var(--sans);
  color: var(--txt);
  letter-spacing: -0.01em;
}
.scn .scn-id {
  font: 400 11px var(--mono);
  color: var(--dim2);
}
.pill {
  font: 700 10px var(--mono);
  padding: 3px 8px;
  border-radius: 4px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.pill.pass { color: #0d2e14; background: var(--green); }
.pill.fail { color: #300808; background: var(--red); }
.pill.native { color: #fff; background: #9a3412; border: 1px solid #c2410c; }

.scn-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 8px 16px;
  background: var(--panel2);
  border-bottom: 1px solid var(--line2);
  font: 12px var(--mono);
  color: var(--dim);
}
.scn-stats b     { color: var(--txt2); font-weight: 600; }
.scn-stats .x    { color: var(--red); }
.scn-stats .ok   { color: var(--green); }
.scn-stat-sep    { color: var(--line); }

.scn-body { padding: 14px 16px; }

details { margin-bottom: 14px; }
details:last-child { margin-bottom: 0; }
summary {
  cursor: pointer;
  font: 500 12px var(--sans);
  color: var(--blue);
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
summary::-webkit-details-marker { display: none; }
summary::before {
  content: '▶';
  font-size: 9px;
  transition: transform 0.15s;
  color: var(--dim);
}
details[open] summary::before { transform: rotate(90deg); }

.agent { margin: 8px 0; }
.agent .nm { font: 600 12px var(--mono); color: var(--txt2); }
.agent .role { color: var(--dim); font-weight: 400; }
pre {
  background: var(--canvas);
  border: 1px solid var(--line2);
  border-radius: 8px;
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12px/1.55 var(--mono);
  color: var(--dim);
  margin: 6px 0 0;
  overflow-x: auto;
}

/* ---- transcript ---- */
.chat { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.msg { max-width: 80%; padding: 8px 12px; border-radius: 10px; }
.msg .meta {
  font: 400 10px var(--mono);
  color: var(--dim2);
  margin-bottom: 3px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.msg .arrow { color: var(--dim2); }
.msg .txt { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; }
.msg.in {
  align-self: flex-start;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-bottom-left-radius: 3px;
}
.msg.out {
  align-self: flex-end;
  background: #122840;
  border: 1px solid #1d3f5e;
  border-bottom-right-radius: 3px;
}
.empty { color: var(--dim); font: 12px var(--mono); padding: 8px 0; }

/* ---- phantoms ---- */
.phantoms {
  margin-top: 12px;
  border: 1px solid var(--red-border);
  background: var(--red-subtle);
  border-radius: 8px;
  padding: 10px 14px;
}
.phantoms .ph-head {
  font: 600 12px var(--sans);
  color: var(--red);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.phantoms ul { list-style: none; display: flex; flex-direction: column; gap: 4px; }
.phantoms li { font: 12px var(--mono); color: var(--txt2); }
.phantoms .snip { color: var(--dim); }

/* ---- matrix styles ---- */
.matrix-table-wrap {
  overflow-x: auto;
  border-radius: 10px;
  border: 1px solid var(--line);
  margin-bottom: 32px;
}
.matrix-table {
  width: 100%;
  border-collapse: collapse;
  font: 13px var(--sans);
  min-width: 680px;
}
.matrix-table thead tr {
  background: var(--panel2);
}
.matrix-table th {
  padding: 10px 14px;
  text-align: left;
  font: 600 10px var(--sans);
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.matrix-table th:first-child { min-width: 200px; }
.matrix-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--line2);
  vertical-align: middle;
}
.matrix-table tbody tr:last-child td { border-bottom: none; }
.matrix-table tbody tr:hover td { background: var(--panel2); }
.matrix-table .harness-cell {
  font: 600 13px var(--sans);
}
.matrix-table .harness-cell a { color: var(--blue); text-decoration: none; }
.matrix-table .harness-cell a:hover { text-decoration: underline; }
.metric-cell {
  font: 600 13px var(--mono);
  white-space: nowrap;
}
.metric-cell.good { color: var(--green); }
.metric-cell.warn { color: var(--amber); }
.metric-cell.bad  { color: var(--red); }
.metric-cell.neutral { color: var(--txt2); }

/* color-coded cell backgrounds */
td.cell-good { background: color-mix(in srgb, var(--green) 8%, transparent); }
td.cell-warn  { background: color-mix(in srgb, var(--amber) 8%, transparent); }
td.cell-bad   { background: color-mix(in srgb, var(--red) 8%, transparent); }

/* ---- mini lifecycle breakdown (matrix page) ---- */
.matrix-lifecycle {
  margin-bottom: 32px;
}
.matrix-lifecycle h2 {
  font: 600 15px var(--sans);
  letter-spacing: -0.01em;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line2);
}
.mini-table-wrap {
  overflow-x: auto;
  border-radius: 10px;
  border: 1px solid var(--line);
}
.mini-table {
  width: 100%;
  border-collapse: collapse;
  font: 13px var(--sans);
}
.mini-table th {
  padding: 8px 14px;
  text-align: left;
  font: 600 10px var(--sans);
  color: var(--dim);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  border-bottom: 1px solid var(--line);
  background: var(--panel2);
  white-space: nowrap;
}
.mini-table td {
  padding: 9px 14px;
  border-bottom: 1px solid var(--line2);
  vertical-align: middle;
}
.mini-table tbody tr:last-child td { border-bottom: none; }
.mini-table tbody tr:hover td { background: var(--panel2); }
.no-data { color: var(--dim); font: 12px var(--mono); padding: 6px 0; }

a { color: var(--blue); }
a:hover { text-decoration: underline; }
`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function rateBarHtml(v: number | undefined, label?: string): string {
  if (v === undefined) return `<span class="no-data">—</span>`;
  const cls = rateClass(v);
  const p = pctNum(v);
  const lbl = label ?? `${p}%`;
  return `<div class="rate-bar">
    <div class="rate-bar-track"><div class="rate-bar-fill ${cls}" style="width:${p}%"></div></div>
    <span class="rate-num ${cls}">${lbl}</span>
  </div>`;
}

function metricCellHtml(v: number | undefined, invert = false): string {
  if (v === undefined) return `<td class="metric-cell neutral">—</td>`;
  const cls = invert ? (v > 0 ? 'bad' : 'good') : rateClass(v);
  const cellCls = `cell-${cls}`;
  return `<td class="metric-cell ${cls} ${cellCls}">${pct(v)}</td>`;
}

function countCellHtml(n: number): string {
  const cls = countClass(n);
  const cellCls = `cell-${cls}`;
  return `<td class="metric-cell ${cls} ${cellCls}">${n}</td>`;
}

function metricCards(m: MetricSet): string {
  const passed = m.scenariosPassed === m.scenariosTotal;
  const cards: Array<{ v: string; l: string; cls: string }> = [
    {
      v: `${m.scenariosPassed}/${m.scenariosTotal}`,
      l: 'Scenarios passed',
      cls: passed ? 'good' : 'bad',
    },
    {
      v: pct(m.messageSentRate),
      l: 'Message-sent rate',
      cls: rateClass(m.messageSentRate),
    },
    ...(m.spawnRate !== undefined
      ? [{ v: pct(m.spawnRate), l: 'Spawn rate', cls: rateClass(m.spawnRate) }]
      : []),
    ...(m.releaseRate !== undefined
      ? [{ v: pct(m.releaseRate), l: 'Release rate', cls: rateClass(m.releaseRate) }]
      : []),
    {
      v: `${pct(m.phantomRate)} (${m.phantomCount})`,
      l: 'Phantom rate',
      cls: m.phantomCount > 0 ? 'bad' : 'good',
    },
    {
      v: pct(m.protocolAdherence),
      l: 'Protocol adherence',
      cls: rateClass(m.protocolAdherence),
    },
    {
      v: pct(m.deliverySuccessRate),
      l: 'Delivery success',
      cls: m.deliverySuccessRate >= 1 ? 'good' : 'bad',
    },
    {
      v: String(m.wrongChannelReplies),
      l: 'Wrong-channel',
      cls: countClass(m.wrongChannelReplies),
    },
  ];
  return `<div class="cards">${cards
    .map(
      (c) =>
        `<div class="card ${c.cls}"><div class="v">${esc(c.v)}</div><div class="l">${esc(c.l)}</div></div>`
    )
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
  const isLifecycle =
    s.spawnCount !== undefined || s.releaseCount !== undefined || s.onboarding !== undefined;

  const statParts: string[] = [
    `sent <b>${s.sent}/${s.expected}</b>`,
    `phantoms <b class="${s.phantoms.length ? 'x' : 'ok'}">${s.phantoms.length}</b>`,
    s.protocolAdherence !== null ? `protocol <b>${pct(s.protocolAdherence)}</b>` : '',
    `wrong-channel <b class="${s.wrongChannelReplies ? 'x' : 'ok'}">${s.wrongChannelReplies}</b>`,
    `delivery <b class="${s.deliveryOk ? 'ok' : 'x'}">${s.deliveryOk ? 'ok' : 'FAILED'}</b>`,
    isLifecycle && s.spawnCount !== undefined
      ? `spawns <b class="${s.spawnCount > 0 ? 'ok' : 'x'}">${s.spawnCount}</b>`
      : '',
    isLifecycle && s.releaseCount !== undefined
      ? `releases <b class="${s.releaseCount > 0 ? 'ok' : 'x'}">${s.releaseCount}</b>`
      : '',
    s.onboarding ? `variant <b>${esc(s.onboarding)}</b>` : '',
    s.nativeSubagentDetected
      ? `tool <b class="x">NATIVE TASK (not add_agent)</b>`
      : '',
    s.notes ? `<span class="scn-stat-sep">·</span> ${esc(s.notes)}` : '',
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
    ? `<div class="phantoms"><div class="ph-head"><span>!</span> ${s.phantoms.length} phantom message(s) — intent stated but no tool call</div><ul>${s.phantoms
        .map(
          (p) =>
            `<li>[${esc(p.agent)}] "${esc(p.verb)}${p.target ? ` ${esc(p.target)}` : ''}" — <span class="snip">${esc(p.snippet)}</span></li>`
        )
        .join('')}</ul></div>`
    : '';

  const nativePill = s.nativeSubagentDetected
    ? `<span class="pill native">NATIVE TASK</span> `
    : '';

  return `<section class="scn">
  <div class="scn-header">
    <span class="pill ${s.pass ? 'pass' : 'fail'}">${s.pass ? 'PASS' : 'FAIL'}</span>
    ${nativePill}<h3>${esc(s.title)}</h3>
    <span class="scn-id">${esc(s.id)}</span>
  </div>
  <div class="scn-stats">${statParts.join('<span class="scn-stat-sep"> · </span>')}</div>
  <div class="scn-body">${agents}<details><summary>Transcript (${s.transcript.length} messages)</summary>${transcriptHtml(s.transcript)}</details>${phantoms}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// Lifecycle variant breakdown (per-report, from scenario list)
// ---------------------------------------------------------------------------

function variantBreakdownHtml(scenarios: ScenarioResult[]): string {
  const lifecycleScenarios = scenarios.filter((s) => s.onboarding !== undefined);
  if (lifecycleScenarios.length === 0) return '';

  // Group by variant
  const byVariant = new Map<string, ScenarioResult[]>();
  for (const s of lifecycleScenarios) {
    const v = s.onboarding!;
    if (!byVariant.has(v)) byVariant.set(v, []);
    byVariant.get(v)!.push(s);
  }

  const rows = Array.from(byVariant.entries())
    .map(([variant, ss]) => {
      const passed = ss.filter((s) => s.pass).length;
      const total = ss.length;
      const passRate = total > 0 ? passed / total : 0;

      const spawns = ss.filter((s) => s.spawnCount !== undefined);
      const spawnRate =
        spawns.length > 0
          ? spawns.filter((s) => (s.spawnCount ?? 0) > 0).length / spawns.length
          : undefined;

      const releases = ss.filter((s) => s.releaseCount !== undefined);
      const releaseRate =
        releases.length > 0
          ? releases.filter((s) => (s.releaseCount ?? 0) > 0).length / releases.length
          : undefined;

      const passCls = rateClass(passRate);
      return `<tr>
        <td class="variant-name">${esc(variant)}</td>
        <td><span class="metric-cell ${passCls}">${passed}/${total}</span></td>
        <td>${rateBarHtml(spawnRate)}</td>
        <td>${rateBarHtml(releaseRate)}</td>
      </tr>`;
    })
    .join('');

  return `<div class="variant-section">
  <div class="vs-header">Pass Rate by Onboarding Variant</div>
  <table class="variant-table">
    <thead><tr>
      <th>Variant</th>
      <th>Passed</th>
      <th>Spawn rate</th>
      <th>Release rate</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ---------------------------------------------------------------------------
// Lifecycle summary table (per-report)
// ---------------------------------------------------------------------------

function lifecycleSummaryHtml(scenarios: ScenarioResult[]): string {
  const lc = scenarios.filter(
    (s) => s.spawnCount !== undefined || s.releaseCount !== undefined || s.onboarding !== undefined
  );
  if (lc.length === 0) return '';

  const rows = lc
    .map((s) => {
      const spawnOk =
        s.spawnCount !== undefined ? (s.spawnCount > 0 ? 'ok' : 'fail') : 'neutral';
      const releaseOk =
        s.releaseCount !== undefined ? (s.releaseCount > 0 ? 'ok' : 'fail') : 'neutral';
      const spawnCell =
        spawnOk === 'ok'
          ? `<span class="metric-cell good">yes (${s.spawnCount})</span>`
          : spawnOk === 'fail'
            ? `<span class="metric-cell bad">no</span>`
            : `<span class="metric-cell neutral">—</span>`;
      const releaseCell =
        releaseOk === 'ok'
          ? `<span class="metric-cell good">yes (${s.releaseCount})</span>`
          : releaseOk === 'fail'
            ? `<span class="metric-cell bad">no</span>`
            : `<span class="metric-cell neutral">—</span>`;
      return `<tr>
        <td><span class="pill ${s.pass ? 'pass' : 'fail'}">${s.pass ? 'PASS' : 'FAIL'}</span></td>
        <td style="font:13px var(--sans);color:var(--txt2)">${esc(s.title)}</td>
        <td>${spawnCell}</td>
        <td>${releaseCell}</td>
        <td style="font:12px var(--mono);color:var(--dim)">${s.onboarding ? esc(s.onboarding) : '—'}</td>
      </tr>`;
    })
    .join('');

  return `<div class="lifecycle-summary">
  <div class="ls-header">Lifecycle Scenario Overview</div>
  <table class="lc-table">
    <thead><tr>
      <th></th>
      <th>Scenario</th>
      <th>Spawn confirmed</th>
      <th>Release confirmed</th>
      <th>Onboarding variant</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ---------------------------------------------------------------------------
// renderReportHtml — per-harness full report
// ---------------------------------------------------------------------------

/** Render one harness report as a full standalone HTML document. */
export function renderReportHtml(report: EvalReport): string {
  const { scenarios } = report;

  // Partition into lifecycle vs messaging
  const lifecycleScenarios = scenarios.filter(
    (s) => s.spawnCount !== undefined || s.releaseCount !== undefined || s.onboarding !== undefined
  );
  const messagingScenarios = scenarios.filter(
    (s) => s.spawnCount === undefined && s.releaseCount === undefined && s.onboarding === undefined
  );

  const passedAll = report.metrics.scenariosPassed === report.metrics.scenariosTotal;

  const sub = [
    `<span class="badge harness">${esc(report.harness)}</span>`,
    `<span class="badge sha">git:${esc(shortSha(report.gitSha))}</span>`,
    `<span class="badge">${esc(report.startedAt)}</span>`,
    `<span class="badge">${(report.durationMs / 1000).toFixed(1)}s</span>`,
    report.env.repeat > 1 ? `<span class="badge">repeat:${report.env.repeat}</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  const summaryPill = `<div class="summary-pill ${passedAll ? 'all-pass' : 'has-fail'}">
    ${passedAll ? '&#10003;' : '&#10007;'} ${report.metrics.scenariosPassed}/${report.metrics.scenariosTotal} passed
  </div>`;

  const lifecycleSection =
    lifecycleScenarios.length > 0
      ? `<div class="section-header">
          <span class="section-icon lifecycle">L</span>
          <h2>Lifecycle — Spawn &amp; Release</h2>
          <span class="count">${lifecycleScenarios.length}</span>
        </div>
        ${variantBreakdownHtml(scenarios)}
        ${lifecycleSummaryHtml(scenarios)}
        ${lifecycleScenarios.map(scenarioHtml).join('')}`
      : '';

  const messagingSection =
    messagingScenarios.length > 0
      ? `<div class="section-header">
          <span class="section-icon messaging">M</span>
          <h2>Messaging</h2>
          <span class="count">${messagingScenarios.length}</span>
        </div>
        ${messagingScenarios.map(scenarioHtml).join('')}`
      : '';

  // If no partitioning happened (all scenarios lack lifecycle markers), just render flat
  const scenariosContent =
    lifecycleSection || messagingSection
      ? lifecycleSection + messagingSection
      : `<div class="section-header"><h2>Scenarios</h2><span class="count">${scenarios.length}</span></div>` +
        scenarios.map(scenarioHtml).join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval Report — ${esc(report.harness)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">
  <div class="page-header">
    <div class="page-header-left">
      <div class="page-title">
        <span class="icon">E</span>
        Agent Eval Report
      </div>
      <div class="page-meta">${sub}</div>
    </div>
    ${summaryPill}
  </div>
  ${metricCards(report.metrics)}
  ${scenariosContent}
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// renderMatrixHtml — cross-model comparison dashboard
// ---------------------------------------------------------------------------

/** Render the matrix roll-up: one row per harness, linking to its report. */
export function renderMatrixHtml(matrix: MatrixReport, links: Record<string, string>): string {
  const harnesses = Object.entries(matrix.harnesses);
  const totalHarnesses = harnesses.length;
  const passingHarnesses = harnesses.filter(
    ([, m]) => m.scenariosPassed === m.scenariosTotal
  ).length;

  // Main matrix table
  const tableRows = harnesses
    .map(([h, m]) => {
      const link = links[h]
        ? `<a href="${esc(links[h])}">${esc(h)}</a>`
        : esc(h);
      const scenariosCls = m.scenariosPassed === m.scenariosTotal ? 'good' : 'bad';
      const scenariosCellCls = `cell-${scenariosCls}`;
      return `<tr>
        <td class="harness-cell">${link}</td>
        <td class="metric-cell ${scenariosCls} ${scenariosCellCls}">${m.scenariosPassed}/${m.scenariosTotal}</td>
        ${metricCellHtml(m.spawnRate)}
        ${metricCellHtml(m.releaseRate)}
        ${metricCellHtml(m.messageSentRate)}
        ${countCellHtml(m.phantomCount)}
        ${metricCellHtml(m.protocolAdherence)}
        ${countCellHtml(m.wrongChannelReplies)}
      </tr>`;
    })
    .join('');

  // Lifecycle variant mini-table: only spawnRate/releaseRate from MetricSet
  const lifecycleMini = harnesses.some(([, m]) => m.spawnRate !== undefined || m.releaseRate !== undefined)
    ? `<div class="matrix-lifecycle">
        <div class="section-header" style="margin-top:0">
          <span class="section-icon lifecycle">L</span>
          <h2>Lifecycle Summary by Model</h2>
        </div>
        <div class="mini-table-wrap">
          <table class="mini-table">
            <thead><tr>
              <th>Harness / Model</th>
              <th>Spawn rate</th>
              <th>Release rate</th>
              <th>Scenarios passed</th>
            </tr></thead>
            <tbody>${harnesses
              .map(([h, m]) => {
                const link = links[h]
                  ? `<a href="${esc(links[h])}">${esc(h)}</a>`
                  : esc(h);
                const passCls = m.scenariosPassed === m.scenariosTotal ? 'good' : 'bad';
                return `<tr>
                  <td style="font:600 13px var(--sans)">${link}</td>
                  <td>${rateBarHtml(m.spawnRate)}</td>
                  <td>${rateBarHtml(m.releaseRate)}</td>
                  <td><span class="metric-cell ${passCls}">${m.scenariosPassed}/${m.scenariosTotal}</span></td>
                </tr>`;
              })
              .join('')}
            </tbody>
          </table>
        </div>
      </div>`
    : '';

  const allPassed = passingHarnesses === totalHarnesses;
  const summaryPill = `<div class="summary-pill ${allPassed ? 'all-pass' : 'has-fail'}">
    ${allPassed ? '&#10003;' : '&#10007;'} ${passingHarnesses}/${totalHarnesses} harnesses passing
  </div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval Matrix — cross-model comparison</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">
  <div class="page-header">
    <div class="page-header-left">
      <div class="page-title">
        <span class="icon">M</span>
        Cross-Model Comparison
      </div>
      <div class="page-meta">
        <span class="badge sha">git:${esc(shortSha(matrix.gitSha))}</span>
        <span class="badge">${esc(matrix.startedAt)}</span>
        <span class="badge">${totalHarnesses} harness${totalHarnesses !== 1 ? 'es' : ''}</span>
      </div>
    </div>
    ${summaryPill}
  </div>

  <div class="matrix-table-wrap">
    <table class="matrix-table">
      <thead><tr>
        <th>Harness / Model</th>
        <th>Scenarios passed</th>
        <th>Spawn rate</th>
        <th>Release rate</th>
        <th>Message-sent %</th>
        <th>Phantom count</th>
        <th>Protocol adherence</th>
        <th>Wrong-channel</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </div>

  ${lifecycleMini}
</div></body></html>`;
}
