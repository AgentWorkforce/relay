'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

interface FadeInProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  direction?: 'up' | 'left' | 'right';
}

export function FadeIn({ children, className, delay = 0, direction = 'up' }: FadeInProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Default visible so SSR/failed hydration never hides critical content.
  const [visible, setVisible] = useState(true);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reveal = () => setVisible(true);

    // Never keep content hidden if observer support or callbacks fail.
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      reveal();
      return;
    }

    // Only animate when JS is active; content remains visible if hydration fails.
    setAnimate(true);

    // If already near/in viewport, keep it visible immediately.
    const rect = el.getBoundingClientRect();
    if (rect.top <= window.innerHeight * 0.95) {
      reveal();
      return;
    }

    // Prepare offscreen elements for reveal-on-scroll animation.
    setVisible(false);

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          reveal();
          observer.unobserve(el);
        }
      },
      { threshold: 0.01, rootMargin: '0px 0px -8% 0px' }
    );

    observer.observe(el);

    // Defensive fallback for browser/extension edge cases where callbacks never fire.
    const fallbackTimer = window.setTimeout(reveal, 1500);

    return () => {
      observer.disconnect();
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  const translateMap = {
    up: 'translateY(30px)',
    left: 'translateX(40px)',
    right: 'translateX(-40px)',
  };

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible || !animate ? 'none' : translateMap[direction],
        transition: animate
          ? `opacity 0.7s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 0.7s cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`
          : undefined,
      }}
    >
      {children}
    </div>
  );
}
