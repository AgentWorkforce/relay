'use client';

import { useEffect, useRef } from 'react';

/**
 * Loads the relaycast hero animation (vanilla JS canvas + DOM cards)
 * from /relaycast-hero-animation.js and initialises it inside a container.
 */
export function RelaycastAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const script = document.createElement('script');
    script.src = '/relaycast-hero-animation.js';
    script.async = true;
    script.onload = () => {
      if (containerRef.current && typeof (window as any).initHeroAnimation === 'function') {
        (window as any).initHeroAnimation('relaycast-hero-anim');
      }
    };
    document.body.appendChild(script);

    return () => {
      // The animation cleans up via the IIFE scope; removing the script
      // tag is sufficient to prevent re-initialisation on hot reload.
      script.remove();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      id="relaycast-hero-anim"
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: 420 }}
    />
  );
}
