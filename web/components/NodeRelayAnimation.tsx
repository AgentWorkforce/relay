'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

import s from './node-relay.module.css';

type ModelProvider = 'claude' | 'gemini' | 'codex' | 'copilot' | 'opencode';

interface AgentNode {
  id: string;
  name: string;
  provider: ModelProvider;
  model: string;
  state: 'IDLE' | 'AWAITING TASK' | 'PROCESSING' | 'RELAYING' | 'COMPLETE';
  statusText: string;
  glowing: boolean;
  glowOpacity: number;
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  driftPhase: number;
  driftSpeed: number;
  driftAmplitudeX: number;
  driftAmplitudeY: number;
  active: boolean;
  opacity: number;
}

interface Message {
  from: number;
  to: number;
  t: number;
  speed: number;
  trail: { x: number; y: number; age: number }[];
  branches?: number[];
  /** If true, this message spawns (activates) the target node on arrival */
  isSpawn?: boolean;
}

const IDLE_TEXTS: Record<ModelProvider, string[]> = {
  claude: ['Waiting for task...', 'Ready'],
  gemini: ['Standing by...', 'Idle'],
  codex: ['Waiting...', 'Idle'],
  copilot: ['Awaiting instructions...', 'Ready'],
  opencode: ['Standing by...', 'Idle'],
};

const WORKING_TEXTS: Record<ModelProvider, string[]> = {
  claude: ['* Thinking...', '* Analyzing codebase...', '* Reading files...', '* Writing code...'],
  gemini: ['Processing query...', 'Searching context...', 'Generating response...'],
  codex: ['Compiling...', 'Running sandbox...', 'Writing patch...'],
  copilot: ['Generating suggestion...', 'Completing code...', 'Reasoning...'],
  opencode: ['$ running task...', '$ reading files...', '$ writing patch...'],
};

const RELAYING_TEXTS: Record<ModelProvider, string[]> = {
  claude: ['* Sending to relay...', '* Handing off...'],
  gemini: ['Forwarding result...', 'Relaying context...'],
  codex: ['Pushing changes...', 'Syncing...'],
  copilot: ['Passing context...', 'Delegating...'],
  opencode: ['$ relaying output...', '$ syncing...'],
};

const NODE_POOL: { name: string; provider: ModelProvider; model: string }[] = [
  { name: 'Lead', provider: 'claude', model: 'Opus' },         // 0
  { name: 'Planner', provider: 'gemini', model: '2.5 Pro' },   // 1
  { name: 'Coder', provider: 'codex', model: 'Codex-1' },      // 2
  { name: 'Reviewer', provider: 'claude', model: 'Sonnet' },    // 3
  { name: 'Frontend', provider: 'copilot', model: 'GPT-4.1' }, // 4
  { name: 'Backend', provider: 'opencode', model: 'Gemini' },   // 5
  { name: 'Marketer', provider: 'gemini', model: '2.5 Flash' }, // 6
  { name: 'Tester', provider: 'claude', model: 'Haiku' },       // 7
];

// Scripted spawn/message sequence: { tick, type, from, to }
// tick = which state-machine tick to fire on
type ScriptEvent =
  | { tick: number; type: 'spawn'; from: number; to: number }
  | { tick: number; type: 'message'; from: number; to: number };

const SCRIPT: ScriptEvent[] = [
  // Lead spawns Planner and Coder
  { tick: 3, type: 'spawn', from: 0, to: 1 },
  { tick: 6, type: 'spawn', from: 0, to: 2 },
  // Lead spawns Reviewer
  { tick: 10, type: 'spawn', from: 0, to: 3 },
  // Planner talks with Coder
  { tick: 14, type: 'message', from: 1, to: 2 },
  { tick: 17, type: 'message', from: 2, to: 1 },
  // Coder spawns Frontend and Backend
  { tick: 21, type: 'spawn', from: 2, to: 4 },
  { tick: 25, type: 'spawn', from: 2, to: 5 },
  // Lead spawns Marketer
  { tick: 29, type: 'spawn', from: 0, to: 6 },
  // Chatter
  { tick: 33, type: 'message', from: 4, to: 3 },
  { tick: 35, type: 'message', from: 5, to: 3 },
  { tick: 38, type: 'message', from: 3, to: 0 },
  // Tester spawns last
  { tick: 42, type: 'spawn', from: 3, to: 7 },
  { tick: 46, type: 'message', from: 0, to: 6 },
  { tick: 49, type: 'message', from: 7, to: 2 },
];

const MAX_NODES = 8;
const CARD_W = 160;
const CARD_H = 88;

// Layout: 1 center + 7 in a single ring, evenly spaced
const NODE_POSITIONS = (() => {
  const cx = 0.38;
  const cy = 0.38;

  const positions: { x: number; y: number }[] = [{ x: cx, y: cy }]; // index 0 = center

  const rings = [
    { count: 7, radius: 0.32 },
  ];

  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const angle = (i / ring.count) * Math.PI * 2 - Math.PI * 0.1; // start slightly right of 0
      const jx = Math.sin(positions.length * 7.3) * 0.01;
      const jy = Math.cos(positions.length * 5.1) * 0.008;
      positions.push({
        x: cx + Math.cos(angle) * ring.radius + jx,
        y: cy + Math.sin(angle) * ring.radius * 0.85 + jy, // squash Y slightly for wider containers
      });
    }
  }

  return positions;
})();

// Build connections: connect to nearest neighbors by distance
function buildConnections(count: number): [number, number][] {
  const conns: [number, number][] = [];
  const threshold = 0.38;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = NODE_POSITIONS[i].x - NODE_POSITIONS[j].x;
      const dy = NODE_POSITIONS[i].y - NODE_POSITIONS[j].y;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) {
        conns.push([i, j]);
      }
    }
  }
  return conns;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isReadyNode(node: AgentNode) {
  return node.active && node.opacity >= 0.9;
}

function enqueueMessage(messages: Message[], message: Omit<Message, 't' | 'trail'>) {
  messages.push({
    ...message,
    t: 0,
    trail: [],
  });
}

function setNodeRelaying(node: AgentNode, statusText: string) {
  node.state = 'RELAYING';
  node.statusText = statusText;
  node.glowing = true;
}

function handleScriptEvents(tick: number, nodes: AgentNode[], messages: Message[]) {
  for (const event of SCRIPT) {
    if (event.tick !== tick) {
      continue;
    }

    if (event.type === 'spawn') {
      setNodeRelaying(nodes[event.from], `Spawning ${nodes[event.to].name}...`);
      enqueueMessage(messages, {
        from: event.from,
        to: event.to,
        speed: 0.02 + Math.random() * 0.008,
        isSpawn: true,
      });
      continue;
    }

    const sender = nodes[event.from];
    if (!isReadyNode(sender)) {
      continue;
    }

    setNodeRelaying(sender, pick(RELAYING_TEXTS[sender.provider]));
    enqueueMessage(messages, {
      from: event.from,
      to: event.to,
      speed: 0.015 + Math.random() * 0.01,
    });
  }
}

function findReadyIndices(nodes: AgentNode[]) {
  return nodes
    .map((node, index) => (isReadyNode(node) ? index : -1))
    .filter((index) => index >= 0);
}

function getActiveNeighbors(senderIdx: number, connections: [number, number][], nodes: AgentNode[]) {
  return connections
    .filter(([a, b]) => a === senderIdx || b === senderIdx)
    .map(([a, b]) => (a === senderIdx ? b : a))
    .filter((index) => isReadyNode(nodes[index]) && index !== senderIdx);
}

function pickRelayTargets(activeNeighbors: number[]) {
  if (activeNeighbors.length >= 2 && Math.random() < 0.3) {
    return [...activeNeighbors].sort(() => Math.random() - 0.5).slice(0, 2);
  }

  return [pick(activeNeighbors)];
}

function maybeQueueRandomRelay(
  tick: number,
  nodes: AgentNode[],
  messages: Message[],
  connections: [number, number][]
) {
  const readyIndices = findReadyIndices(nodes);
  const scriptDone = tick > (SCRIPT.length > 0 ? SCRIPT[SCRIPT.length - 1].tick + 5 : 0);
  if (!scriptDone || tick % 3 !== 0 || readyIndices.length < 2) {
    return;
  }

  const senderIdx = pick(readyIndices);
  const activeNeighbors = getActiveNeighbors(senderIdx, connections, nodes);
  if (activeNeighbors.length === 0) {
    return;
  }

  const sender = nodes[senderIdx];
  setNodeRelaying(sender, pick(RELAYING_TEXTS[sender.provider]));

  for (const target of pickRelayTargets(activeNeighbors)) {
    enqueueMessage(messages, {
      from: senderIdx,
      to: target,
      speed: 0.015 + Math.random() * 0.012,
      branches: Math.random() < 0.25 && readyIndices.length > 1 ? [pick(readyIndices)] : undefined,
    });
  }
}

function cycleNodeStates(nodes: AgentNode[], tick: number) {
  for (const node of nodes) {
    if (node.state === 'COMPLETE') {
      node.state = 'AWAITING TASK';
      node.statusText = pick(IDLE_TEXTS[node.provider]);
    }

    if (node.state === 'RELAYING' && tick % 3 === 0) {
      node.state = 'COMPLETE';
      node.statusText = 'Done';
    }

    if (node.state === 'PROCESSING' && Math.random() < 0.15) {
      node.statusText = pick(WORKING_TEXTS[node.provider]);
    }
  }
}

function updateNodePositions(nodes: AgentNode[], now: number) {
  for (const node of nodes) {
    const t = now * node.driftSpeed + node.driftPhase;
    node.x = node.baseX + Math.sin(t) * node.driftAmplitudeX + Math.cos(t * 0.7) * node.driftAmplitudeX * 0.5;
    node.y = node.baseY + Math.cos(t * 1.3) * node.driftAmplitudeY + Math.sin(t * 0.5) * node.driftAmplitudeY * 0.4;

    node.opacity = node.active
      ? Math.min(node.opacity + 0.08, 1)
      : Math.max(node.opacity - 0.03, 0);

    node.glowOpacity = node.glowing
      ? Math.min(node.glowOpacity + 0.06, 1)
      : Math.max(node.glowOpacity - 0.02, 0);

    if (node.glowOpacity > 0.85) {
      node.glowing = false;
    }
  }
}

type NodeCenter = { cx: number; cy: number; opacity: number };

function buildCenters(nodes: AgentNode[], w: number, h: number): NodeCenter[] {
  return nodes.map((node) => ({
    cx: node.x * w + CARD_W / 2,
    cy: node.y * h + CARD_H / 2,
    opacity: node.opacity,
  }));
}

function drawConnectionLines(
  ctx: CanvasRenderingContext2D,
  centers: NodeCenter[],
  connections: [number, number][]
) {
  for (const [i, j] of connections) {
    const ci = centers[i];
    const cj = centers[j];
    if (!ci || !cj) {
      continue;
    }

    const lineOpacity = Math.min(ci.opacity, cj.opacity) * 0.1;
    if (lineOpacity < 0.01) {
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(ci.cx, ci.cy);
    ctx.lineTo(cj.cx, cj.cy);
    ctx.strokeStyle = `rgba(45, 79, 62, ${lineOpacity})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawMessageTrail(ctx: CanvasRenderingContext2D, message: Message) {
  for (let trailIndex = message.trail.length - 1; trailIndex >= 0; trailIndex--) {
    const point = message.trail[trailIndex];
    point.age++;
    const trailAlpha = Math.max(0, 0.22 - point.age * 0.004);

    if (trailAlpha <= 0) {
      message.trail.splice(trailIndex, 1);
      continue;
    }

    const trailSize = Math.max(0.5, 2.5 - point.age * 0.03);
    ctx.beginPath();
    ctx.arc(point.x, point.y, trailSize, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(74, 144, 194, ${trailAlpha})`;
    ctx.fill();
  }
}

function drawMessagePulse(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, 14);
  grad.addColorStop(0, 'rgba(74, 144, 194, 0.5)');
  grad.addColorStop(0.4, 'rgba(74, 144, 194, 0.15)');
  grad.addColorStop(1, 'rgba(74, 144, 194, 0)');
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(74, 144, 194, 0.8)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(234, 230, 221, 0.9)';
  ctx.fill();
}

function handleMessageArrival(message: Message, nodes: AgentNode[], messages: Message[]) {
  const receiver = nodes[message.to];
  if (!receiver) {
    return;
  }

  if (message.isSpawn && !receiver.active) {
    receiver.active = true;
    receiver.state = 'AWAITING TASK';
    receiver.statusText = pick(IDLE_TEXTS[receiver.provider]);
    receiver.glowing = true;
  } else if (receiver.active) {
    receiver.state = 'PROCESSING';
    receiver.statusText = pick(WORKING_TEXTS[receiver.provider]);
    receiver.glowing = true;
  }

  if (!message.branches || !receiver.active) {
    return;
  }

  const branchTargets = message.branches.filter(
    (branchTarget) => branchTarget !== message.to && branchTarget !== message.from && nodes[branchTarget]?.active
  );

  if (branchTargets.length === 0) {
    return;
  }

  for (const branchTarget of branchTargets) {
    enqueueMessage(messages, {
      from: message.to,
      to: branchTarget,
      speed: 0.014 + Math.random() * 0.01,
    });
  }

  receiver.state = 'RELAYING';
  receiver.statusText = pick(RELAYING_TEXTS[receiver.provider]);
}

function drawMessages(
  ctx: CanvasRenderingContext2D,
  nodes: AgentNode[],
  messages: Message[],
  centers: NodeCenter[]
) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    message.t += message.speed;

    const from = centers[message.from];
    const to = centers[message.to];
    if (!from || !to) {
      messages.splice(messageIndex, 1);
      continue;
    }

    const progress = easeInOut(Math.min(message.t, 1));
    const px = lerp(from.cx, to.cx, progress);
    const py = lerp(from.cy, to.cy, progress);

    message.trail.push({ x: px, y: py, age: 0 });
    drawMessageTrail(ctx, message);

    if (message.t <= 1) {
      drawMessagePulse(ctx, px, py);
      continue;
    }

    handleMessageArrival(message, nodes, messages);
    messages.splice(messageIndex, 1);
  }
}

function drawGlowRings(ctx: CanvasRenderingContext2D, nodes: AgentNode[], centers: NodeCenter[]) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.glowOpacity <= 0.01 || node.opacity <= 0.1) {
      continue;
    }

    const center = centers[i];
    const radius = 56;
    const alpha = node.glowOpacity * node.opacity * 0.07;
    const grad = ctx.createRadialGradient(center.cx, center.cy, radius * 0.6, center.cx, center.cy, radius);
    grad.addColorStop(0, `rgba(45, 79, 62, ${alpha})`);
    grad.addColorStop(1, 'rgba(45, 79, 62, 0)');
    ctx.beginPath();
    ctx.arc(center.cx, center.cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

// ── SVG logos from pear/AgentIcons ──

function ClaudeLogo() {
  return (
    <svg className={s.providerLogo} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
        fill="#C1674B"
      />
    </svg>
  );
}

function CodexLogo() {
  return (
    <svg className={s.providerLogo} viewBox="0 0 268 266" fill="none" aria-hidden="true">
      <g transform="translate(-146 -227)">
        <path
          d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

function CopilotLogo() {
  return (
    <svg className={s.providerLogo} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"
        fill="currentColor"
      />
    </svg>
  );
}

function OpenCodeLogo() {
  return (
    <svg className={s.providerLogo} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="2" width="16" height="20" fill="#7A7A72" />
      <rect x="8" y="6" width="8" height="6" fill="#F5F4F0" />
      <rect x="8" y="12" width="8" height="7" fill="#5A5A54" />
    </svg>
  );
}

function GeminiLogo() {
  return (
    <svg className={s.providerLogo} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF" />
      <path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#ngf0)" />
      <path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#ngf1)" />
      <path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="url(#ngf2)" />
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id="ngf0" x1="7" x2="11" y1="15.5" y2="12"><stop stopColor="#08B962" /><stop offset="1" stopColor="#08B962" stopOpacity="0" /></linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id="ngf1" x1="8" x2="11.5" y1="5.5" y2="11"><stop stopColor="#F94543" /><stop offset="1" stopColor="#F94543" stopOpacity="0" /></linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id="ngf2" x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stopColor="#FABC12" /><stop offset=".46" stopColor="#FABC12" stopOpacity="0" /></linearGradient>
      </defs>
    </svg>
  );
}

const LOGO_MAP: Record<ModelProvider, () => JSX.Element> = {
  claude: ClaudeLogo,
  codex: CodexLogo,
  copilot: CopilotLogo,
  opencode: OpenCodeLogo,
  gemini: GeminiLogo,
};

export function NodeRelayAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<AgentNode[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const connectionsRef = useRef<[number, number][]>([]);
  const rafRef = useRef(0);
  const tickRef = useRef(0);
  const timeRef = useRef(0);
  const [renderNodes, setRenderNodes] = useState<AgentNode[]>([]);

  const initNodes = useCallback(() => {
    // Start with only the center node (index 0 = Lead) active
    const created: AgentNode[] = NODE_POOL.map((def, i) => ({
      id: `node-${i}`,
      name: def.name,
      provider: def.provider,
      model: def.model,
      state: i === 0 ? 'PROCESSING' : 'IDLE',
      statusText: i === 0 ? pick(WORKING_TEXTS[def.provider]) : '',
      glowing: i === 0,
      glowOpacity: 0,
      baseX: NODE_POSITIONS[i].x,
      baseY: NODE_POSITIONS[i].y,
      x: NODE_POSITIONS[i].x,
      y: NODE_POSITIONS[i].y,
      driftPhase: Math.random() * Math.PI * 2,
      driftSpeed: 0.0003 + Math.random() * 0.0004,
      driftAmplitudeX: 0.008 + Math.random() * 0.01,
      driftAmplitudeY: 0.006 + Math.random() * 0.008,
      active: i === 0,
      opacity: i === 0 ? 1 : 0,
    }));
    nodesRef.current = created;
    connectionsRef.current = buildConnections(MAX_NODES);
    messagesRef.current = [];
    setRenderNodes([...created]);
  }, []);

  useEffect(() => {
    initNodes();
  }, [initNodes]);

  // State machine
  useEffect(() => {
    const interval = setInterval(() => {
      const tick = tickRef.current++;
      const ns = nodesRef.current;
      const ms = messagesRef.current;
      handleScriptEvents(tick, ns, ms);
      maybeQueueRandomRelay(tick, ns, ms, connectionsRef.current);
      cycleNodeStates(ns, tick);

      setRenderNodes([...ns]);
    }, 250);

    return () => clearInterval(interval);
  }, []);

  // Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const ns = nodesRef.current;
      const ms = messagesRef.current;
      const now = timeRef.current++;

      ctx.clearRect(0, 0, w, h);
      updateNodePositions(ns, now);
      const centers = buildCenters(ns, w, h);
      drawConnectionLines(ctx, centers, connectionsRef.current);
      drawMessages(ctx, ns, ms, centers);
      drawGlowRings(ctx, ns, centers);

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} className={s.container}>
      <canvas ref={canvasRef} className={s.canvas} />
      {renderNodes.map((node) => {
        const Logo = LOGO_MAP[node.provider];
        const isBusy = node.state === 'PROCESSING' || node.state === 'RELAYING';
        return (
          <div
            key={node.id}
            className={`${s.card} ${isBusy ? s.cardActive : ''}`}
            style={{
              left: `${node.x * 100}%`,
              top: `${node.y * 100}%`,
              opacity: node.opacity,
              transform: `scale(${0.92 + node.opacity * 0.08})`,
              boxShadow: node.glowOpacity > 0
                ? `0 0 ${18 * node.glowOpacity}px rgba(45, 79, 62, ${0.15 * node.glowOpacity}), 0 2px 10px rgba(0,0,0,0.08)`
                : '0 2px 8px rgba(0,0,0,0.06)',
              pointerEvents: node.opacity < 0.1 ? 'none' : undefined,
            }}
          >
            <div className={s.cardHeader}>
              <div className={s.cardIdentity}>
                <Logo />
                <span className={s.cardName}>{node.name}</span>
              </div>
              <span className={s.cardModel}>{node.model}</span>
            </div>
            <div className={s.cardStatus}>
              {isBusy && <span className={s.statusDot} />}
              <span className={`${s.statusText} ${isBusy ? s.statusActive : ''}`}>
                {node.statusText}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
