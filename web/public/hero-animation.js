/**
 * Relaycast Hero Animation
 * Messaging-focused node relay — agents exchange messages via channels.
 * Matches relay's NodeRelayAnimation style: floating cards + canvas trails.
 * Pure vanilla JS, no dependencies.
 */

(function () {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────────── */

  var CARD_W = 160;
  var CARD_H = 88;
  var MAX_NODES = 8;
  var TRAIL_COLOR = 'rgba(74, 144, 194, ';
  var GLOW_COLOR = 'rgba(45, 79, 62, ';

  /* ── Provider SVG logos (inline HTML) ──────────────────────────── */

  var LOGO_SVG = {
    claude: '<svg class="anim-provider-logo" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="#C1674B"/></svg>',
    codex: '<svg class="anim-provider-logo" viewBox="0 0 268 266" fill="none" aria-hidden="true"><g transform="translate(-146 -227)"><path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z" fill="currentColor"/></g></svg>',
    copilot: '<svg class="anim-provider-logo" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" fill="currentColor"/></svg>',
    gemini: '<svg class="anim-provider-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"/></svg>',
  };

  /* ── Message event kinds ─────────────────────────────────────── */

  var MSG_KINDS = ['channel', 'dm', 'thread', 'reaction'];

  var LANDING_BY_KIND = {
    channel:  ['#general: Starting task...', '#dev: PR ready', '#alerts: CPU spike', '#dev: Deployed'],
    dm:       ['DM: Check the logs?', 'DM: Incident resolved', 'DM: Can you review?', 'DM: Tests green'],
    thread:   ['Thread: re: deploy plan', 'Thread: re: auth fix', 'Thread: re: perf spike', 'Thread: follow-up'],
    reaction: ['\u{1F44D} reacted', '\u{2705} reacted', '\u{1F680} reacted', '\u{1F440} reacted', '\u{2764}\uFE0F reacted', '\u{1F389} reacted'],
  };

  var STATUS_BY_KIND = {
    channel:  ['Posting to #general...', 'Sending to #dev...', 'Posting to #alerts...'],
    dm:       ['DM \u2192 Reviewer...', 'DM \u2192 Lead...', 'DM \u2192 Coder...'],
    thread:   ['Replying in thread...', 'Thread reply...', 'Following up...'],
    reaction: ['Reacting \u{1F44D}...', 'Reacting \u{2705}...', 'Reacting \u{1F680}...'],
  };

  var NODE_POOL = [
    { name: 'Lead',      model: 'Opus',      provider: 'claude'  },
    { name: 'Planner',   model: 'Sonnet',    provider: 'claude'  },
    { name: 'Coder',     model: 'Codex-1',   provider: 'codex'   },
    { name: 'Reviewer',  model: 'Haiku',     provider: 'claude'  },
    { name: 'Frontend',  model: 'GPT-4.1',   provider: 'copilot' },
    { name: 'Backend',   model: 'Gemini',    provider: 'gemini'  },
    { name: 'Ops',       model: 'Flash',     provider: 'gemini'  },
    { name: 'Tester',    model: 'Sonnet',    provider: 'claude'  },
  ];

  var IDLE_TEXTS = {
    claude:  ['Waiting for task...', 'Ready'],
    codex:   ['Waiting...', 'Idle'],
    copilot: ['Awaiting instructions...', 'Ready'],
    gemini:  ['Standing by...', 'Idle'],
  };

  var WORKING_TEXTS = {
    claude:  ['Thinking...', 'Analyzing...', 'Reading files...', 'Writing code...'],
    codex:   ['Compiling...', 'Running sandbox...', 'Writing patch...'],
    copilot: ['Generating...', 'Completing code...', 'Reasoning...'],
    gemini:  ['Processing...', 'Searching context...', 'Generating...'],
  };

  var RELAYING_TEXTS = {
    claude:  ['Sending to #general...', 'Posting to #dev...', 'DM → Reviewer...'],
    codex:   ['Pushing to #dev...', 'Syncing channel...'],
    copilot: ['Posting update...', 'Relaying to #alerts...'],
    gemini:  ['Forwarding to #general...', 'Relaying context...'],
  };

  // Scripted spawn/message sequence
  var SCRIPT = [
    { tick:  3, type: 'spawn',   from: 0, to: 1 },
    { tick:  6, type: 'spawn',   from: 0, to: 2 },
    { tick: 10, type: 'spawn',   from: 0, to: 3 },
    { tick: 14, type: 'message', from: 1, to: 2 },
    { tick: 17, type: 'message', from: 2, to: 1 },
    { tick: 21, type: 'spawn',   from: 2, to: 4 },
    { tick: 25, type: 'spawn',   from: 2, to: 5 },
    { tick: 29, type: 'spawn',   from: 0, to: 6 },
    { tick: 33, type: 'message', from: 4, to: 3 },
    { tick: 35, type: 'message', from: 5, to: 3 },
    { tick: 38, type: 'message', from: 3, to: 0 },
    { tick: 42, type: 'spawn',   from: 3, to: 7 },
    { tick: 46, type: 'message', from: 0, to: 6 },
    { tick: 49, type: 'message', from: 7, to: 2 },
  ];

  /* ── Node positions: 1 center + 7 ring ────────────────────────── */

  var NODE_POSITIONS = (function () {
    var cx = 0.38, cy = 0.38;
    var positions = [{ x: cx, y: cy }];
    var count = 7, radius = 0.32;
    for (var i = 0; i < count; i++) {
      var angle = (i / count) * Math.PI * 2 - Math.PI * 0.1;
      var jx = Math.sin(positions.length * 7.3) * 0.01;
      var jy = Math.cos(positions.length * 5.1) * 0.008;
      positions.push({
        x: cx + Math.cos(angle) * radius + jx,
        y: cy + Math.sin(angle) * radius * 0.85 + jy,
      });
    }
    return positions;
  })();

  /* ── Connections between nearby nodes ──────────────────────────── */

  function buildConnections(count) {
    var conns = [];
    var threshold = 0.38;
    for (var i = 0; i < count; i++) {
      for (var j = i + 1; j < count; j++) {
        var dx = NODE_POSITIONS[i].x - NODE_POSITIONS[j].x;
        var dy = NODE_POSITIONS[i].y - NODE_POSITIONS[j].y;
        if (Math.sqrt(dx * dx + dy * dy) < threshold) {
          conns.push([i, j]);
        }
      }
    }
    return conns;
  }

  /* ── Helpers ───────────────────────────────────────────────────── */

  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function isReady(node) { return node.active && node.opacity >= 0.9; }

  /* ── State ─────────────────────────────────────────────────────── */

  var container, canvas, ctx;
  var nodes = [];
  var messages = [];
  var connections = [];
  var tick = 0;
  var time = 0;

  /* ── Init ──────────────────────────────────────────────────────── */

  function init(containerId) {
    container = document.getElementById(containerId);
    if (!container) return;

    // Create canvas
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;z-index:0;pointer-events:none;';
    container.style.position = 'relative';
    container.appendChild(canvas);
    ctx = canvas.getContext('2d');

    // Create node cards (DOM)
    initNodes();
    connections = buildConnections(MAX_NODES);

    resize();
    window.addEventListener('resize', resize, { passive: true });

    // State machine: tick every 250ms
    setInterval(stateTick, 250);

    // Render loop
    requestAnimationFrame(draw);
  }

  function initNodes() {
    nodes = [];
    for (var i = 0; i < NODE_POOL.length; i++) {
      var def = NODE_POOL[i];
      var pos = NODE_POSITIONS[i];
      var node = {
        id: 'node-' + i,
        name: def.name,
        provider: def.provider,
        model: def.model,
        state: i === 0 ? 'PROCESSING' : 'IDLE',
        statusText: i === 0 ? pick(WORKING_TEXTS[def.provider]) : '',
        glowing: i === 0,
        glowOpacity: 0,
        baseX: pos.x,
        baseY: pos.y,
        x: pos.x,
        y: pos.y,
        driftPhase: Math.random() * Math.PI * 2,
        driftSpeed: 0.0003 + Math.random() * 0.0004,
        driftAmplitudeX: 0.008 + Math.random() * 0.01,
        driftAmplitudeY: 0.006 + Math.random() * 0.008,
        active: i === 0,
        opacity: i === 0 ? 1 : 0,
        el: null,
      };
      node.el = createCardEl(node);
      container.appendChild(node.el);
      nodes.push(node);
    }
  }

  function createCardEl(node) {
    var card = document.createElement('div');
    card.className = 'anim-card';
    var logoHtml = LOGO_SVG[node.provider] || '';
    card.innerHTML =
      '<div class="anim-card-header">' +
        '<div class="anim-card-identity">' +
          logoHtml +
          '<span class="anim-card-name">' + node.name + '</span>' +
        '</div>' +
        '<span class="anim-card-model">' + node.model + '</span>' +
      '</div>' +
      '<div class="anim-card-status">' +
        '<span class="anim-status-dot"></span>' +
        '<span class="anim-status-text">' + node.statusText + '</span>' +
      '</div>';
    return card;
  }

  /* ── Landing toasts: brief message shown at receiver node ──────── */

  var landingToasts = [];

  function spawnLandingToast(x, y, kind) {
    var snippets = LANDING_BY_KIND[kind] || LANDING_BY_KIND.channel;
    var text = pick(snippets);
    landingToasts.push({ x: x, y: y - 30, text: text, kind: kind, age: 0, maxAge: 100, alpha: 0 });
  }

  var cachedCardW = CARD_W;
  var cachedCardH = CARD_H;

  function updateCachedCardSize() {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].el) {
        cachedCardW = nodes[i].el.offsetWidth || CARD_W;
        cachedCardH = nodes[i].el.offsetHeight || CARD_H;
        return;
      }
    }
  }

  function resize() {
    if (!container || !canvas) return;
    var rect = container.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateCachedCardSize();
  }

  /* ── State machine (250ms tick) ────────────────────────────────── */

  function stateTick() {
    var t = tick++;
    handleScriptEvents(t);
    maybeQueueRandomRelay(t);
    cycleNodeStates(t);
    updateDOM();
  }

  function handleScriptEvents(t) {
    for (var i = 0; i < SCRIPT.length; i++) {
      var ev = SCRIPT[i];
      if (ev.tick !== t) continue;

      if (ev.type === 'spawn') {
        var sender = nodes[ev.from];
        sender.state = 'RELAYING';
        sender.statusText = 'Spawning ' + nodes[ev.to].name + '...';
        sender.glowing = true;
        enqueueMessage(ev.from, ev.to, 0.008 + Math.random() * 0.004, true);
      } else {
        var s = nodes[ev.from];
        if (!isReady(s)) continue;
        var kind = pick(MSG_KINDS);
        s.state = 'RELAYING';
        s.statusText = pick(STATUS_BY_KIND[kind]);
        s.glowing = true;
        enqueueMessageWithKind(ev.from, ev.to, 0.007 + Math.random() * 0.005, false, null, kind);
      }
    }
  }

  function maybeQueueRandomRelay(t) {
    var scriptDone = SCRIPT.length > 0 ? t > SCRIPT[SCRIPT.length - 1].tick + 5 : true;
    if (!scriptDone || t % 3 !== 0) return;

    var ready = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isReady(nodes[i])) ready.push(i);
    }
    if (ready.length < 2) return;

    var senderIdx = pick(ready);
    var neighbors = getActiveNeighbors(senderIdx);
    if (neighbors.length === 0) return;

    var sender = nodes[senderIdx];
    var kind = pick(MSG_KINDS);
    sender.state = 'RELAYING';
    sender.statusText = pick(STATUS_BY_KIND[kind]);
    sender.glowing = true;

    var targets = (neighbors.length >= 2 && Math.random() < 0.3)
      ? neighbors.sort(function () { return Math.random() - 0.5; }).slice(0, 2)
      : [pick(neighbors)];

    for (var i = 0; i < targets.length; i++) {
      var branches = (Math.random() < 0.25 && ready.length > 1) ? [pick(ready)] : null;
      enqueueMessageWithKind(senderIdx, targets[i], 0.007 + Math.random() * 0.005, false, branches, kind);
    }
  }

  function getActiveNeighbors(senderIdx) {
    var result = [];
    for (var i = 0; i < connections.length; i++) {
      var a = connections[i][0], b = connections[i][1];
      if (a === senderIdx && isReady(nodes[b]) && b !== senderIdx) result.push(b);
      if (b === senderIdx && isReady(nodes[a]) && a !== senderIdx) result.push(a);
    }
    return result;
  }

  function cycleNodeStates(t) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.state === 'COMPLETE') {
        n.state = 'AWAITING TASK';
        n.statusText = pick(IDLE_TEXTS[n.provider]);
      }
      if (n.state === 'RELAYING' && t % 3 === 0) {
        n.state = 'COMPLETE';
        n.statusText = 'Done';
      }
      if (n.state === 'PROCESSING' && Math.random() < 0.15) {
        n.statusText = pick(WORKING_TEXTS[n.provider]);
      }
    }
  }

  function enqueueMessage(from, to, speed, isSpawn, branches) {
    enqueueMessageWithKind(from, to, speed, isSpawn, branches, isSpawn ? 'channel' : pick(MSG_KINDS));
  }

  function enqueueMessageWithKind(from, to, speed, isSpawn, branches, kind) {
    messages.push({
      from: from,
      to: to,
      speed: speed,
      isSpawn: !!isSpawn,
      kind: kind || 'channel',
      branches: branches || null,
      t: 0,
      trail: [],
    });
  }

  /* ── DOM update (sync card positions + state) ──────────────────── */

  function updateDOM() {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var el = n.el;
      if (!el) continue;

      var isBusy = n.state === 'PROCESSING' || n.state === 'RELAYING';
      el.style.opacity = n.opacity;
      el.style.transform = 'scale(' + (0.92 + n.opacity * 0.08) + ')';
      el.style.pointerEvents = n.opacity < 0.1 ? 'none' : '';
      el.style.borderColor = isBusy
        ? 'var(--agent-card-border-active, rgba(116,184,226,0.3))'
        : 'var(--agent-card-border, rgba(116,184,226,0.16))';

      if (n.glowOpacity > 0.01) {
        el.style.boxShadow = '0 0 ' + (18 * n.glowOpacity) + 'px ' + GLOW_COLOR + (0.15 * n.glowOpacity) + '), 0 2px 10px rgba(0,0,0,0.08)';
      } else {
        el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)';
      }

      // Update status text
      var statusTextEl = el.querySelector('.anim-status-text');
      if (statusTextEl && statusTextEl.textContent !== n.statusText) {
        statusTextEl.textContent = n.statusText;
      }

      // Show/hide dot
      var dotEl = el.querySelector('.anim-status-dot');
      if (dotEl) {
        dotEl.style.display = isBusy ? 'inline-block' : 'none';
      }
    }
  }

  /* ── Canvas render loop ────────────────────────────────────────── */

  function draw() {
    var rect = container.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;
    var now = time++;

    ctx.clearRect(0, 0, w, h);

    updateNodePositions(now);
    positionCards(w, h);

    var centers = buildCenters(w, h);
    drawConnectionLines(centers);
    drawMessages(centers);
    drawGlowRings(centers);
    drawLandingToasts();

    requestAnimationFrame(draw);
  }

  function updateNodePositions(now) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = now * n.driftSpeed + n.driftPhase;
      n.x = n.baseX + Math.sin(t) * n.driftAmplitudeX + Math.cos(t * 0.7) * n.driftAmplitudeX * 0.5;
      n.y = n.baseY + Math.cos(t * 1.3) * n.driftAmplitudeY + Math.sin(t * 0.5) * n.driftAmplitudeY * 0.4;

      n.opacity = n.active
        ? Math.min(n.opacity + 0.08, 1)
        : Math.max(n.opacity - 0.03, 0);

      n.glowOpacity = n.glowing
        ? Math.min(n.glowOpacity + 0.06, 1)
        : Math.max(n.glowOpacity - 0.02, 0);

      if (n.glowOpacity > 0.85) n.glowing = false;
    }
  }

  function positionCards(w, h) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.el) continue;
      n.el.style.left = (n.x * w) + 'px';
      n.el.style.top = (n.y * h) + 'px';
    }
  }

  function buildCenters(w, h) {
    var result = [];
    for (var i = 0; i < nodes.length; i++) {
      result.push({
        cx: nodes[i].x * w + cachedCardW / 2,
        cy: nodes[i].y * h + cachedCardH / 2,
        opacity: nodes[i].opacity,
      });
    }
    return result;
  }

  function drawConnectionLines(centers) {
    for (var i = 0; i < connections.length; i++) {
      var a = connections[i][0], b = connections[i][1];
      var ci = centers[a], cj = centers[b];
      if (!ci || !cj) continue;

      var lineOpacity = Math.min(ci.opacity, cj.opacity) * 0.1;
      if (lineOpacity < 0.01) continue;

      ctx.beginPath();
      ctx.moveTo(ci.cx, ci.cy);
      ctx.lineTo(cj.cx, cj.cy);
      ctx.strokeStyle = GLOW_COLOR + lineOpacity + ')';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function drawMessages(centers) {
    for (var i = messages.length - 1; i >= 0; i--) {
      var msg = messages[i];
      msg.t += msg.speed;

      var from = centers[msg.from];
      var to = centers[msg.to];
      if (!from || !to) { messages.splice(i, 1); continue; }

      var progress = easeInOut(Math.min(msg.t, 1));
      var px = lerp(from.cx, to.cx, progress);
      var py = lerp(from.cy, to.cy, progress);

      msg.trail.push({ x: px, y: py, age: 0 });

      // Trail color by kind
      var kindTrail = {
        channel:  TRAIL_COLOR,
        dm:       'rgba(99, 209, 139, ',
        thread:   'rgba(193, 103, 75, ',
        reaction: 'rgba(254, 188, 46, ',
      };
      var tc = kindTrail[msg.kind] || TRAIL_COLOR;

      // Draw trail — thicker and longer-lasting
      for (var j = msg.trail.length - 1; j >= 0; j--) {
        var pt = msg.trail[j];
        pt.age++;
        var trailAlpha = Math.max(0, 0.3 - pt.age * 0.003);
        if (trailAlpha <= 0) { msg.trail.splice(j, 1); continue; }
        var trailSize = Math.max(1, 4 - pt.age * 0.03);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, trailSize, 0, Math.PI * 2);
        ctx.fillStyle = tc + trailAlpha + ')';
        ctx.fill();
      }

      // Draw pulse icon
      if (msg.t <= 1) {
        drawPulse(px, py, msg.kind);
        continue;
      }

      // Arrival
      handleArrival(msg, centers);
      messages.splice(i, 1);
    }
  }

  function drawPulse(x, y, kind) {
    var glowColors = {
      channel:  TRAIL_COLOR,
      dm:       'rgba(99, 209, 139, ',
      thread:   'rgba(193, 103, 75, ',
      reaction: 'rgba(254, 188, 46, ',
    };
    var gc = glowColors[kind] || TRAIL_COLOR;

    // Large outer glow so the icon is unmissable
    var grad = ctx.createRadialGradient(x, y, 0, x, y, 32);
    grad.addColorStop(0, gc + '0.35)');
    grad.addColorStop(0.5, gc + '0.08)');
    grad.addColorStop(1, gc + '0)');
    ctx.beginPath();
    ctx.arc(x, y, 32, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Solid backdrop pill so the icon is readable over connection lines
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 27, 41, 0.7)';
    ctx.fill();

    if (kind === 'channel') {
      // ── Speech bubble with text lines ──
      var bw = 28, bh = 20, br = 5;
      var bx = x - bw / 2, by = y - bh / 2 - 2;
      ctx.beginPath();
      ctx.moveTo(bx + br, by);
      ctx.lineTo(bx + bw - br, by);
      ctx.arcTo(bx + bw, by, bx + bw, by + br, br);
      ctx.lineTo(bx + bw, by + bh - br);
      ctx.arcTo(bx + bw, by + bh, bx + bw - br, by + bh, br);
      ctx.lineTo(bx + 12, by + bh);
      ctx.lineTo(bx + 6, by + bh + 8);
      ctx.lineTo(bx + 9, by + bh);
      ctx.lineTo(bx + br, by + bh);
      ctx.arcTo(bx, by + bh, bx, by + bh - br, br);
      ctx.lineTo(bx, by + br);
      ctx.arcTo(bx, by, bx + br, by, br);
      ctx.closePath();
      ctx.fillStyle = gc + '0.85)';
      ctx.fill();
      // Text lines inside
      ctx.fillStyle = 'rgba(234, 230, 221, 0.9)';
      ctx.fillRect(bx + 5, by + 5, bw - 10, 2.5);
      ctx.fillRect(bx + 5, by + 10, bw - 14, 2.5);
      ctx.fillRect(bx + 5, by + 15, bw - 18, 2);

    } else if (kind === 'dm') {
      // ── Envelope icon ──
      var ew = 28, eh = 20;
      var ex = x - ew / 2, ey = y - eh / 2;
      // Envelope body
      ctx.beginPath();
      ctx.roundRect(ex, ey, ew, eh, 3);
      ctx.fillStyle = gc + '0.85)';
      ctx.fill();
      // Flap (V shape)
      ctx.strokeStyle = 'rgba(234, 230, 221, 0.95)';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(ex + 2, ey + 2);
      ctx.lineTo(x, ey + eh * 0.55);
      ctx.lineTo(ex + ew - 2, ey + 2);
      ctx.stroke();
      // Small arrow →  inside lower half
      ctx.strokeStyle = 'rgba(234, 230, 221, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 5, ey + eh - 5);
      ctx.lineTo(x + 5, ey + eh - 5);
      ctx.moveTo(x + 3, ey + eh - 7);
      ctx.lineTo(x + 5, ey + eh - 5);
      ctx.lineTo(x + 3, ey + eh - 3);
      ctx.stroke();

    } else if (kind === 'thread') {
      // ── Branch / reply icon ──
      ctx.strokeStyle = gc + '0.9)';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Vertical stem
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 10);
      ctx.lineTo(x - 6, y + 4);
      // Curve to right
      ctx.quadraticCurveTo(x - 6, y + 10, x + 2, y + 10);
      ctx.lineTo(x + 10, y + 10);
      ctx.stroke();
      // Arrow head
      ctx.beginPath();
      ctx.moveTo(x + 7, y + 7);
      ctx.lineTo(x + 11, y + 10);
      ctx.lineTo(x + 7, y + 13);
      ctx.stroke();
      // Dot at origin
      ctx.beginPath();
      ctx.arc(x - 6, y - 10, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = gc + '0.95)';
      ctx.fill();
      // Second branch (shorter, dimmer)
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 2);
      ctx.quadraticCurveTo(x - 6, y + 2, x, y + 2);
      ctx.lineTo(x + 4, y + 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

    } else if (kind === 'reaction') {
      // ── Emoji circle ──
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fillStyle = gc + '0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(234, 230, 221, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Emoji
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var emojis = ['\uD83D\uDC4D', '\u2705', '\uD83D\uDE80', '\uD83D\uDC40', '\u2764\uFE0F', '\uD83C\uDF89'];
      ctx.fillText(pick(emojis), x, y + 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  function handleArrival(msg, centers) {
    var receiver = nodes[msg.to];
    if (!receiver) return;

    // Spawn a landing toast at the receiver's position
    if (centers && centers[msg.to]) {
      spawnLandingToast(centers[msg.to].cx, centers[msg.to].cy, msg.kind);
    }

    if (msg.isSpawn && !receiver.active) {
      receiver.active = true;
      receiver.state = 'AWAITING TASK';
      receiver.statusText = pick(IDLE_TEXTS[receiver.provider]);
      receiver.glowing = true;
    } else if (receiver.active) {
      receiver.state = 'PROCESSING';
      receiver.statusText = pick(WORKING_TEXTS[receiver.provider]);
      receiver.glowing = true;
    }

    if (!msg.branches || !receiver.active) return;
    for (var i = 0; i < msg.branches.length; i++) {
      var bt = msg.branches[i];
      if (bt !== msg.to && bt !== msg.from && nodes[bt] && nodes[bt].active) {
        enqueueMessage(msg.to, bt, 0.007 + Math.random() * 0.005, false);
      }
    }
    receiver.state = 'RELAYING';
    receiver.statusText = pick(RELAYING_TEXTS[receiver.provider]);
  }

  function drawGlowRings(centers) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.glowOpacity <= 0.01 || n.opacity <= 0.1) continue;
      var c = centers[i];
      var radius = 56;
      var alpha = n.glowOpacity * n.opacity * 0.07;
      var grad = ctx.createRadialGradient(c.cx, c.cy, radius * 0.6, c.cx, c.cy, radius);
      grad.addColorStop(0, GLOW_COLOR + alpha + ')');
      grad.addColorStop(1, GLOW_COLOR + '0)');
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  /* ── Landing toasts rendering ────────────────────────────────── */

  function drawLandingToasts() {
    for (var i = landingToasts.length - 1; i >= 0; i--) {
      var toast = landingToasts[i];
      toast.age++;

      // Fade in for first 12 frames, hold, fade out last 18
      if (toast.age < 12) {
        toast.alpha = toast.age / 12;
      } else if (toast.age > toast.maxAge - 18) {
        toast.alpha = (toast.maxAge - toast.age) / 18;
      } else {
        toast.alpha = 1;
      }

      // Drift upward slowly
      toast.y -= 0.3;

      if (toast.age >= toast.maxAge) {
        landingToasts.splice(i, 1);
        continue;
      }

      if (toast.alpha <= 0.01) continue;

      ctx.save();
      ctx.globalAlpha = toast.alpha * 0.88;

      // Measure text
      ctx.font = '600 11px "JetBrains Mono", monospace';
      var tw = ctx.measureText(toast.text).width;
      var pw = tw + 20;
      var ph = 24;
      var px = toast.x - pw / 2;
      var py = toast.y - ph / 2;
      var pr = ph / 2;

      // Color by kind
      var toastColors = {
        channel:  { border: TRAIL_COLOR + '0.35)',          text: 'rgba(116, 184, 226, 0.95)' },
        dm:       { border: 'rgba(99, 209, 139, 0.35)',     text: 'rgba(99, 209, 139, 0.95)' },
        thread:   { border: 'rgba(193, 103, 75, 0.35)',     text: 'rgba(193, 103, 75, 0.95)' },
        reaction: { border: 'rgba(254, 188, 46, 0.35)',     text: 'rgba(254, 188, 46, 0.95)' },
      };
      var tc = toastColors[toast.kind] || toastColors.channel;

      // Pill background
      ctx.beginPath();
      ctx.moveTo(px + pr, py);
      ctx.lineTo(px + pw - pr, py);
      ctx.arcTo(px + pw, py, px + pw, py + pr, pr);
      ctx.arcTo(px + pw, py + ph, px + pw - pr, py + ph, pr);
      ctx.lineTo(px + pr, py + ph);
      ctx.arcTo(px, py + ph, px, py + pr, pr);
      ctx.arcTo(px, py, px + pr, py, pr);
      ctx.closePath();
      ctx.fillStyle = 'rgba(15, 27, 41, 0.9)';
      ctx.fill();
      ctx.strokeStyle = tc.border;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Text
      ctx.fillStyle = tc.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(toast.text, toast.x, toast.y);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      ctx.restore();
    }
  }

  /* ── Public ────────────────────────────────────────────────────── */

  function initHeroAnimation(containerId) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(containerId); });
      return;
    }
    init(containerId);
  }

  window.initHeroAnimation = initHeroAnimation;
})();
