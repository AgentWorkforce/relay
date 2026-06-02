'use client';

import { useEffect, useState } from 'react';

import { MessageRelayAnimation } from '../MessageRelayAnimation';

// Matches the mobile breakpoint in landing.module.css where .heroRight is hidden.
const MOBILE_QUERY = '(max-width: 600px)';

type MediaQueryListWithLegacyListeners = MediaQueryList & {
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};

function subscribeToMediaQuery(mql: MediaQueryList, listener: () => void) {
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }

  const legacyMql = mql as MediaQueryListWithLegacyListeners;
  legacyMql.addListener?.(listener);
  return () => legacyMql.removeListener?.(listener);
}

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
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsDesktop(!mql.matches);

    update();
    return subscribeToMediaQuery(mql, update);
  }, []);

  if (!isDesktop) {
    return null;
  }

  return <MessageRelayAnimation />;
}
