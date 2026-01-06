/**
 * Usage Banner Component
 *
 * Displays remaining compute hours for free tier users.
 * Shows warning when approaching limit and upgrade CTA when exceeded.
 */

import React, { useEffect, useState } from 'react';

interface UsageData {
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  limits: {
    computeHoursPerMonth: number;
  };
  usage: {
    computeHoursThisMonth: number;
  };
  percentUsed: {
    computeHours: number;
  };
}

export interface UsageBannerProps {
  /** API base URL (default: '') */
  apiBaseUrl?: string;
  /** Callback when upgrade is clicked */
  onUpgradeClick?: () => void;
}

export function UsageBanner({ apiBaseUrl = '', onUpgradeClick }: UsageBannerProps) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    async function fetchUsage() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/usage`, {
          credentials: 'include',
        });

        if (!response.ok) {
          if (response.status === 401) {
            // Not logged in, don't show banner
            setLoading(false);
            return;
          }
          throw new Error('Failed to fetch usage');
        }

        const data = await response.json();
        setUsage(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    fetchUsage();

    // Refresh every 5 minutes
    const interval = setInterval(fetchUsage, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [apiBaseUrl]);

  // Don't show for non-free plans
  if (loading || error || !usage || usage.plan !== 'free' || dismissed) {
    return null;
  }

  const { computeHoursThisMonth } = usage.usage;
  const { computeHoursPerMonth } = usage.limits;
  const percentUsed = usage.percentUsed.computeHours;
  const remaining = Math.max(0, computeHoursPerMonth - computeHoursThisMonth);
  const isExceeded = remaining <= 0;
  const isWarning = percentUsed >= 80 && !isExceeded;

  // Get current month name
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long' });

  // Determine banner style
  let bgClass = 'bg-bg-tertiary border-border-subtle';
  let textClass = 'text-text-secondary';
  let iconColor = 'text-accent-cyan';

  if (isExceeded) {
    bgClass = 'bg-error/10 border-error/30';
    textClass = 'text-error';
    iconColor = 'text-error';
  } else if (isWarning) {
    bgClass = 'bg-warning/10 border-warning/30';
    textClass = 'text-warning';
    iconColor = 'text-warning';
  }

  return (
    <div className={`flex items-center justify-between px-4 py-2 border-b ${bgClass}`}>
      <div className="flex items-center gap-3">
        <ClockIcon className={iconColor} />
        <span className={`text-sm ${textClass}`}>
          {isExceeded ? (
            <>
              <strong>Compute limit reached</strong> — Your free tier compute hours for {monthName} have been used.
              Workspaces are paused until next month.
            </>
          ) : isWarning ? (
            <>
              <strong>{remaining.toFixed(1)}h remaining</strong> — You&apos;ve used {percentUsed}% of your
              free tier compute hours for {monthName}.
            </>
          ) : (
            <>
              <strong>{remaining.toFixed(1)} of {computeHoursPerMonth}h</strong> compute hours remaining
              this month
            </>
          )}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {(isExceeded || isWarning) && (
          <button
            onClick={onUpgradeClick || (() => window.location.href = '/pricing')}
            className="px-3 py-1.5 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold border-none rounded-md text-xs cursor-pointer transition-all duration-150 hover:shadow-glow-cyan hover:-translate-y-0.5"
          >
            Upgrade Plan
          </button>
        )}

        {!isExceeded && (
          <button
            onClick={() => setDismissed(true)}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
            aria-label="Dismiss"
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default UsageBanner;
