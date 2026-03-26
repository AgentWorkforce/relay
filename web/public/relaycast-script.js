const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';
const POSTHOG_PUBLIC_KEY = 'phc_OAqBdey9pESZCcwaen9Fpyz6Ez8QKiMmLOnvFknXzg4';
const POSTHOG_DISTINCT_ID_KEY = 'relaycast_posthog_distinct_id';
const POSTHOG_SESSION_ID = window.crypto?.randomUUID?.() ?? String(Date.now());

function getMetaContent(name) {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() ?? '';
}

function getOrCreateDistinctId() {
  try {
    const existing = localStorage.getItem(POSTHOG_DISTINCT_ID_KEY);
    if (existing) return existing;
    const next = window.crypto?.randomUUID?.() ?? `anon-${Date.now()}`;
    localStorage.setItem(POSTHOG_DISTINCT_ID_KEY, next);
    return next;
  } catch {
    return window.crypto?.randomUUID?.() ?? `anon-${Date.now()}`;
  }
}

const telemetry = (() => {
  // Check for Do Not Track
  const dnt = navigator.doNotTrack === '1' || 
              navigator.doNotTrack === 'yes' ||
              window.doNotTrack === '1' ||
              navigator.msDoNotTrack === '1';

  if (dnt) {
    return {
      enabled: false,
      capture: () => {}, // no-op when DNT is enabled
    };
  }

  const posthogKey =
    window.POSTHOG_API_KEY ||
    window.RELAYCAST_POSTHOG_KEY ||
    getMetaContent('relaycast-posthog-key') ||
    POSTHOG_PUBLIC_KEY;

  const rawHost =
    window.POSTHOG_HOST || window.RELAYCAST_POSTHOG_HOST || getMetaContent('relaycast-posthog-host');
  const host = (rawHost || POSTHOG_DEFAULT_HOST).replace(/\/$/, '');
  const distinctId = getOrCreateDistinctId();

  const capture = (event, properties = {}) => {
    const payload = {
      api_key: posthogKey,
      event,
      distinct_id: distinctId,
      properties: {
        surface: 'site',
        session_id: POSTHOG_SESSION_ID,
        path: window.location.pathname,
        hostname: window.location.hostname,
        ...properties,
      },
    };

    const body = JSON.stringify(payload);
    const url = `${host}/capture/`;

    if (navigator.sendBeacon) {
      const sent = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      if (sent) return;
    }

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  };

  return {
    enabled: true,
    capture,
  };
})();

function sanitizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    // Only keep UTM parameters and other safe tracking params
    const safeParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'];
    const filteredParams = new URLSearchParams();
    safeParams.forEach(param => {
      const value = parsed.searchParams.get(param);
      if (value) filteredParams.set(param, value);
    });
    const queryString = filteredParams.toString();
    return queryString ? `?${queryString}` : null;
  } catch {
    return null;
  }
}

function sanitizeReferrer(referrer) {
  if (!referrer) return null;
  try {
    const parsed = new URL(referrer);
    // Only send the origin (protocol + hostname), not the full URL
    return parsed.origin;
  } catch {
    return null;
  }
}

function trackSiteView() {
  telemetry.capture('relaycast_site_viewed', {
    referrer: sanitizeReferrer(document.referrer),
    query_params: sanitizeUrl(window.location.href),
  });
}

function trackCtaClick(anchor) {
  const section = anchor.closest('section')?.id || anchor.closest('nav')?.className || 'unknown';
  const destination = anchor.getAttribute('href') || '';
  const ctaName = anchor.dataset.telemetryCta || anchor.textContent?.trim() || 'unknown';

  telemetry.capture('relaycast_site_cta_clicked', {
    cta_name: ctaName,
    section,
    destination,
    is_external: anchor.target === '_blank' || /^[a-z][a-z\d+.-]*:/i.test(destination),
  });

  const installIntent =
    destination === '#get-started' ||
    ctaName.includes('docs') ||
    ctaName.includes('get_started') ||
    ctaName.includes('github');

  if (installIntent) {
    telemetry.capture('relaycast_site_install_intent', {
      cta_name: ctaName,
      section,
      destination,
    });
  }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const anchor = target.closest('a');
  if (!anchor) return;

  if (anchor.classList.contains('pricing-cta')) {
    telemetry.capture('relaycast_site_pricing_clicked', {
      plan: anchor.dataset.pricingPlan || 'unknown',
      cta_text: anchor.textContent?.trim() || 'unknown',
      destination: anchor.getAttribute('href') || '',
    });
  }

  if (anchor.dataset.telemetryCta) {
    trackCtaClick(anchor);
  }
});

const viewedSections = new Set();
const sectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const sectionId = entry.target.id;
      if (!sectionId || viewedSections.has(sectionId)) return;
      viewedSections.add(sectionId);
      telemetry.capture('relaycast_site_section_viewed', { section: sectionId });
    });
  },
  { threshold: 0.35 },
);

document.querySelectorAll('section[id]').forEach((section) => {
  sectionObserver.observe(section);
});

// SDK tab switching
document.querySelectorAll('.sdk-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sdk-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.code-panel').forEach((panel) => panel.classList.remove('active'));
    tab.classList.add('active');
    const nextPanel = document.getElementById(`code-${tab.dataset.lang}`);
    if (nextPanel) nextPanel.classList.add('active');

    telemetry.capture('relaycast_site_sdk_tab_selected', {
      tab: tab.dataset.lang ?? 'unknown',
    });
  });
});

// Intersection observer for fade-in on scroll
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  },
  { threshold: 0.1, rootMargin: '0px 0px -40px 0px' },
);

document.querySelectorAll('.feature-card, .why-card, .step, .tool-badge, .webhook-card, .commands-card, .pricing-card').forEach((el) => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(16px)';
  el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  observer.observe(el);
});

trackSiteView();
