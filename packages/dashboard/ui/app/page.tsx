'use client';

import { useState, useEffect } from 'react';
import { LandingPage } from '../landing';
import { App } from '../react-components/App';

/**
 * Detect if running in cloud mode (should show landing page at root)
 * Local mode shows the dashboard directly at root
 */
function detectCloudMode(): boolean {
  if (typeof window === 'undefined') return false;

  const hostname = window.location.hostname;
  const params = new URLSearchParams(window.location.search);

  // Query param for testing: ?landing=true or ?cloud=true
  if (params.get('landing') === 'true' || params.get('cloud') === 'true') return true;

  // Cloud URL patterns
  if (hostname.includes('agent-relay.com')) return true;
  if (hostname.includes('agentrelay.dev')) return true;
  if (hostname.includes('.fly.dev')) return true;

  // Cloud mode flag in meta tags
  const cloudMeta = document.querySelector('meta[name="agent-relay-cloud"]');
  if (cloudMeta?.getAttribute('content') === 'true') return true;

  // Cloud mode in local storage (for development)
  if (localStorage.getItem('agent-relay-cloud-mode') === 'true') return true;

  return false;
}

export default function HomePage() {
  // Default to local mode (dashboard) - this is the most common case when
  // running via agent-relay up. Cloud mode is only for hosted deployment.
  const [isCloud, setIsCloud] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setIsCloud(detectCloudMode());
    setIsReady(true);
  }, []);

  // Show dashboard-styled loading state while detecting mode
  // This prevents flash of unstyled content
  if (!isReady) {
    return (
      <div className="flex h-screen bg-bg-deep font-sans text-text-primary items-center justify-center">
        <div className="text-text-muted">Loading...</div>
      </div>
    );
  }

  // Cloud mode: show landing page at root
  // Local mode: show dashboard at root
  return isCloud ? <LandingPage /> : <App />;
}
