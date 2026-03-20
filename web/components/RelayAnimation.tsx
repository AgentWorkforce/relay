'use client';

import { useCallback, useEffect, useRef } from 'react';

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  shade: number; // 0-1, blends between lighter and darker moss
}

interface Pulse {
  fromIdx: number;
  toIdx: number;
  t: number;
  speed: number;
}

const NODE_COUNT = 28;
const CONNECTION_DISTANCE = 160;
const PULSE_CHANCE = 0.008;

// Moss / forest palette
const BG_CENTER = '#ece8e0'; // warm oatmeal, slightly lighter center
const BG_EDGE = '#e5e1d8';   // slightly darker edge
const NODE_LIGHT = 'rgba(45, 79, 62, 0.7)';   // #2D4F3E at 70%
const NODE_DARK = 'rgba(58, 100, 78, 0.85)';   // slightly brighter moss
const GLOW_COLOR = 'rgba(45, 79, 62, 0.12)';
const LINE_COLOR_R = 45;
const LINE_COLOR_G = 79;
const LINE_COLOR_B = 62;
const PULSE_CENTER = 'rgba(45, 79, 62, 0.55)';
const PULSE_MID = 'rgba(45, 79, 62, 0.18)';
const PULSE_EDGE = 'rgba(45, 79, 62, 0)';

export default function RelayAnimation({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const pulsesRef = useRef<Pulse[]>([]);
  const rafRef = useRef<number>(0);
  const sizeRef = useRef({ w: 0, h: 0 });

  const initNodes = useCallback((w: number, h: number) => {
    const nodes: Node[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      nodes.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.3) * 0.6,
        vy: (Math.random() - 0.5) * 0.25,
        radius: 2.5 + Math.random() * 2,
        shade: Math.random(),
      });
    }
    nodesRef.current = nodes;
    pulsesRef.current = [];
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (sizeRef.current.w === 0 || nodesRef.current.length === 0) {
        initNodes(w, h);
      } else {
        const sx = w / sizeRef.current.w;
        const sy = h / sizeRef.current.h;
        for (const node of nodesRef.current) {
          node.x *= sx;
          node.y *= sy;
        }
      }
      sizeRef.current = { w, h };
    };

    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      const { w, h } = sizeRef.current;
      const nodes = nodesRef.current;
      const pulses = pulsesRef.current;

      ctx.clearRect(0, 0, w, h);

      // Background — warm oatmeal with subtle radial gradient
      const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, w * 0.7);
      bgGrad.addColorStop(0, BG_CENTER);
      bgGrad.addColorStop(1, BG_EDGE);
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // Update nodes
      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;

        // Wrap horizontally (marquee)
        if (node.x > w + 20) node.x = -20;
        if (node.x < -20) node.x = w + 20;

        // Bounce vertically with gentle drift
        if (node.y < 20 || node.y > h - 20) {
          node.vy *= -1;
        }
      }

      // Draw connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < CONNECTION_DISTANCE) {
            const alpha = (1 - dist / CONNECTION_DISTANCE) * 0.15;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.strokeStyle = `rgba(${LINE_COLOR_R}, ${LINE_COLOR_G}, ${LINE_COLOR_B}, ${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.stroke();

            // Maybe spawn a pulse
            if (Math.random() < PULSE_CHANCE) {
              pulses.push({
                fromIdx: i,
                toIdx: j,
                t: 0,
                speed: 0.008 + Math.random() * 0.012,
              });
            }
          }
        }
      }

      // Draw pulses
      for (let p = pulses.length - 1; p >= 0; p--) {
        const pulse = pulses[p];
        pulse.t += pulse.speed;

        if (pulse.t > 1) {
          pulses.splice(p, 1);
          continue;
        }

        const from = nodes[pulse.fromIdx];
        const to = nodes[pulse.toIdx];
        if (!from || !to) {
          pulses.splice(p, 1);
          continue;
        }

        const px = from.x + (to.x - from.x) * pulse.t;
        const py = from.y + (to.y - from.y) * pulse.t;

        const grad = ctx.createRadialGradient(px, py, 0, px, py, 7);
        grad.addColorStop(0, PULSE_CENTER);
        grad.addColorStop(0.5, PULSE_MID);
        grad.addColorStop(1, PULSE_EDGE);
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Draw nodes
      for (const node of nodes) {
        // Glow
        const glowGrad = ctx.createRadialGradient(
          node.x, node.y, 0,
          node.x, node.y, node.radius * 5
        );
        glowGrad.addColorStop(0, GLOW_COLOR);
        glowGrad.addColorStop(1, 'rgba(45, 79, 62, 0)');
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * 5, 0, Math.PI * 2);
        ctx.fillStyle = glowGrad;
        ctx.fill();

        // Core
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = node.shade > 0.5 ? NODE_DARK : NODE_LIGHT;
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(rafRef.current);
    };
  }, [initNodes]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  );
}
