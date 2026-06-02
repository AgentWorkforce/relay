'use client';

import { useEffect, useState } from 'react';

import { MessageRelayAnimation } from '../MessageRelayAnimation';

// Matches the mobile breakpoint in landing.module.css where .heroRight is hidden.
const DESKTOP_QUERY = '(min-width: 601px)';

/**
 * Renders the hero's animated node graph only above the mobile breakpoint.
 *
 * The graph is a canvas animation with a continuous requestAnimationFrame loop,
 * so on mobile we avoid mounting it entirely (rather than just hiding it with
 * CSS) to keep the page lightweight on phones.
 */
export function HeroGraph() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(mql.matches);

    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  if (!isDesktop) {
    return null;
  }

  return <MessageRelayAnimation />;
}
