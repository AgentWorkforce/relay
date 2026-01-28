/**
 * Billing Settings Panel
 *
 * Manage subscription, view plans, and access billing portal.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { cloudApi } from '../../lib/cloudApi';

export interface BillingSettingsPanelProps {
  onUpgrade?: () => void;
}

interface Plan {
  tier: string;
  name: string;
  description: string;
  price: { monthly: number; yearly: number };
  features: string[];
  limits: Record<string, number>;
  recommended?: boolean;
}

interface Subscription {
  id: string;
  tier: string;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  interval: 'month' | 'year';
}

interface Invoice {
  id: string;
  number: string;
  amount: number;
  status: string;
  date: string;
  pdfUrl?: string;
}

const TIER_COLORS: Record<string, string> = {
  free: 'bg-bg-tertiary border-border-subtle text-text-muted',
  pro: 'bg-accent-cyan/10 border-accent-cyan/30 text-accent-cyan',
  team: 'bg-blue-900/30 border-blue-500/40 text-blue-400',
  enterprise: 'bg-amber-400/10 border-amber-400/30 text-amber-400',
};

const TIER_DESCRIPTIONS: Record<string, string> = {
  free: 'Free tier - upgrade to unlock more features',
  pro: 'Professional plan with enhanced features',
  team: 'Team plan with collaboration features',
  enterprise: 'Enterprise plan with dedicated support',
};

// Tier ranking for comparison (higher = better plan)
const TIER_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
};

export function BillingSettingsPanel({ onUpgrade }: BillingSettingsPanelProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [currentTier, setCurrentTier] = useState<string>('free');
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Billing interval toggle
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month');

  // Action loading states
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);

  // Load billing data
  useEffect(() => {
    async function loadBillingData() {
      setIsLoading(true);
      setError(null);

      const [plansResult, subscriptionResult, invoicesResult] = await Promise.all([
        cloudApi.getBillingPlans(),
        cloudApi.getSubscription(),
        cloudApi.getInvoices(),
      ]);

      if (plansResult.success) {
        setPlans(plansResult.data.plans);
      }

      if (subscriptionResult.success) {
        setCurrentTier(subscriptionResult.data.tier);
        setSubscription(subscriptionResult.data.subscription);
        if (subscriptionResult.data.subscription?.interval) {
          setBillingInterval(subscriptionResult.data.subscription.interval);
        }
      }

      if (invoicesResult.success) {
        setInvoices(invoicesResult.data.invoices);
      }

      if (!plansResult.success) {
        setError(plansResult.error);
      }

      setIsLoading(false);
    }

    loadBillingData();
  }, []);

  // Start checkout for plan upgrade
  const handleCheckout = useCallback(async (tier: string) => {
    setCheckoutLoading(tier);

    const result = await cloudApi.createCheckoutSession(tier, billingInterval);

    if (result.success && result.data.checkoutUrl) {
      // Redirect to Stripe checkout
      window.location.href = result.data.checkoutUrl;
    } else if (!result.success) {
      setError(result.error);
      setCheckoutLoading(null);
    }
  }, [billingInterval]);

  // Open billing portal
  const handleOpenPortal = useCallback(async () => {
    setPortalLoading(true);

    const result = await cloudApi.createBillingPortal();

    if (result.success && result.data.portalUrl) {
      window.location.href = result.data.portalUrl;
    } else if (!result.success) {
      setError(result.error);
    }

    setPortalLoading(false);
  }, []);

  // Cancel subscription
  const handleCancel = useCallback(async () => {
    const confirmed = window.confirm(
      'Are you sure you want to cancel your subscription? You will retain access until the end of your billing period.'
    );
    if (!confirmed) return;

    setCancelLoading(true);

    const result = await cloudApi.cancelSubscription();

    if (result.success) {
      setSubscription((prev) =>
        prev ? { ...prev, cancelAtPeriodEnd: true } : null
      );
      setSuccessMessage(result.data.message);
      setTimeout(() => setSuccessMessage(null), 5000);
    } else {
      setError(result.error);
    }

    setCancelLoading(false);
  }, []);

  // Resume subscription
  const handleResume = useCallback(async () => {
    setResumeLoading(true);

    const result = await cloudApi.resumeSubscription();

    if (result.success) {
      setSubscription((prev) =>
        prev ? { ...prev, cancelAtPeriodEnd: false } : null
      );
      setSuccessMessage(result.data.message);
      setTimeout(() => setSuccessMessage(null), 3000);
    } else {
      setError(result.error);
    }

    setResumeLoading(false);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner />
        <span className="ml-3 text-text-muted">Loading billing information...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Messages */}
      {error && (
        <div className="p-3 bg-error/10 border border-error/30 rounded-lg text-error text-sm">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 text-error/70 hover:text-error"
          >
            &times;
          </button>
        </div>
      )}

      {successMessage && (
        <div className="p-3 bg-success/10 border border-success/30 rounded-lg text-success text-sm">
          {successMessage}
        </div>
      )}

      {/* Current Plan */}
      <div>
        <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
          Current Plan
        </h3>
        <div className={`p-4 md:p-6 rounded-lg border-2 ${TIER_COLORS[currentTier]}`}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h4 className="text-lg md:text-xl font-bold text-text-primary capitalize">
                {currentTier} Plan
              </h4>
              {subscription ? (
                <p className="text-xs md:text-sm text-text-secondary mt-1">
                  {subscription.cancelAtPeriodEnd ? (
                    <span className="text-amber-400">
                      Cancels on {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                    </span>
                  ) : (
                    <>
                      Renews on {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                      <span className="text-text-muted ml-2">
                        ({subscription.interval === 'year' ? 'Yearly' : 'Monthly'})
                      </span>
                    </>
                  )}
                </p>
              ) : (
                <p className="text-xs md:text-sm text-text-muted mt-1">
                  {TIER_DESCRIPTIONS[currentTier] || TIER_DESCRIPTIONS.free}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {subscription && !subscription.cancelAtPeriodEnd && (
                <button
                  onClick={handleCancel}
                  disabled={cancelLoading}
                  className="px-3 md:px-4 py-2 bg-bg-hover text-text-secondary rounded-lg text-xs md:text-sm font-medium hover:text-text-primary disabled:opacity-50 transition-colors"
                >
                  {cancelLoading ? 'Canceling...' : 'Cancel Plan'}
                </button>
              )}
              {subscription?.cancelAtPeriodEnd && (
                <button
                  onClick={handleResume}
                  disabled={resumeLoading}
                  className="px-3 md:px-4 py-2 bg-success/20 text-success rounded-lg text-xs md:text-sm font-medium hover:bg-success/30 disabled:opacity-50 transition-colors"
                >
                  {resumeLoading ? 'Resuming...' : 'Resume Plan'}
                </button>
              )}
              {subscription && (
                <button
                  onClick={handleOpenPortal}
                  disabled={portalLoading}
                  className="px-3 md:px-4 py-2 bg-accent-cyan text-bg-deep rounded-lg text-xs md:text-sm font-medium hover:bg-accent-cyan/90 disabled:opacity-50 transition-colors"
                >
                  {portalLoading ? 'Opening...' : 'Manage Billing'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Billing Interval Toggle */}
      <div className="flex items-center justify-center gap-4">
        <span
          className={`text-sm font-medium ${
            billingInterval === 'month' ? 'text-text-primary' : 'text-text-muted'
          }`}
        >
          Monthly
        </span>
        <button
          onClick={() => setBillingInterval((prev) => (prev === 'month' ? 'year' : 'month'))}
          className="relative w-14 h-7 bg-bg-tertiary rounded-full transition-colors"
        >
          <span
            className={`absolute top-1 w-5 h-5 bg-accent-cyan rounded-full transition-transform ${
              billingInterval === 'year' ? 'translate-x-8' : 'translate-x-1'
            }`}
          />
        </button>
        <span
          className={`text-sm font-medium ${
            billingInterval === 'year' ? 'text-text-primary' : 'text-text-muted'
          }`}
        >
          Yearly
          <span className="ml-1 text-xs text-success">(Save 20%)</span>
        </span>
      </div>

      {/* Available Plans */}
      <div>
        <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
          Available Plans
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans
            .filter((p) => p.tier !== 'free')
            .map((plan) => {
              // Only show recommended styling for upgrades, not downgrades
              const isUpgrade = (TIER_RANK[plan.tier] || 0) > (TIER_RANK[currentTier] || 0);
              const showRecommended = plan.recommended && isUpgrade;
              const isDowngrade = (TIER_RANK[plan.tier] || 0) < (TIER_RANK[currentTier] || 0);

              return (
                <div
                  key={plan.tier}
                  className={`relative p-6 rounded-lg border ${
                    showRecommended
                      ? 'border-accent-cyan shadow-glow-cyan'
                      : 'border-border-subtle'
                  } bg-bg-tertiary`}
                >
                  {showRecommended && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-accent-cyan text-bg-deep text-xs font-bold rounded-full">
                      Most Popular
                    </div>
                  )}

                  <h4 className="text-lg font-bold text-text-primary">{plan.name}</h4>
                  <p className="text-xs text-text-muted mt-1 mb-4">{plan.description}</p>

                  <div className="mb-4">
                    <span className="text-3xl font-bold text-text-primary">
                      ${billingInterval === 'year' ? plan.price.yearly : plan.price.monthly}
                    </span>
                    <span className="text-text-muted">
                      /{billingInterval === 'year' ? 'year' : 'month'}
                    </span>
                  </div>

                  <ul className="space-y-2 mb-6">
                    {plan.features.slice(0, 5).map((feature, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-text-secondary">
                        <CheckIcon className="text-success shrink-0 mt-0.5" />
                        {feature}
                      </li>
                    ))}
                  </ul>

                  {currentTier === plan.tier ? (
                    <button
                      disabled
                      className="w-full py-2.5 bg-bg-hover text-text-muted rounded-lg text-sm font-medium cursor-default"
                    >
                      Current Plan
                    </button>
                  ) : (
                    <button
                      onClick={() => handleCheckout(plan.tier)}
                      disabled={checkoutLoading !== null}
                      className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                        showRecommended
                          ? 'bg-accent-cyan text-bg-deep hover:bg-accent-cyan/90'
                          : 'bg-bg-hover text-text-primary hover:bg-bg-active'
                      }`}
                    >
                      {checkoutLoading === plan.tier
                        ? 'Loading...'
                        : isDowngrade
                        ? 'Downgrade'
                        : 'Upgrade'}
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      {/* Enterprise CTA */}
      <div className="p-4 md:p-6 bg-gradient-to-r from-amber-400/10 to-accent-purple/10 border border-amber-400/20 rounded-lg">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h4 className="text-base md:text-lg font-bold text-text-primary">Enterprise</h4>
            <p className="text-xs md:text-sm text-text-secondary mt-1">
              Custom solutions for large teams with dedicated support, SLA, and custom integrations.
            </p>
          </div>
          <a
            href="mailto:enterprise@agent-relay.com"
            className="px-4 md:px-6 py-2 md:py-2.5 bg-amber-400 text-bg-deep rounded-lg text-xs md:text-sm font-bold hover:bg-amber-300 transition-colors text-center shrink-0"
          >
            Contact Sales
          </a>
        </div>
      </div>

      {/* Invoices */}
      {invoices.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-4">
            Billing History
          </h3>

          {/* Desktop Table */}
          <div className="hidden md:block bg-bg-tertiary rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase">
                    Invoice
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase">
                    Date
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase">
                    Amount
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase">
                    Status
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-text-muted uppercase">

                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-3 text-sm text-text-primary font-medium">
                      {invoice.number}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {new Date(invoice.date).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary">
                      ${(invoice.amount / 100).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-1 rounded-full ${
                          invoice.status === 'paid'
                            ? 'bg-success/20 text-success'
                            : invoice.status === 'open'
                            ? 'bg-amber-400/20 text-amber-400'
                            : 'bg-error/20 text-error'
                        }`}
                      >
                        {invoice.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {invoice.pdfUrl && (
                        <a
                          href={invoice.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-accent-cyan hover:underline"
                        >
                          Download
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Card Layout */}
          <div className="md:hidden space-y-3">
            {invoices.map((invoice) => (
              <div key={invoice.id} className="bg-bg-tertiary rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-text-primary">{invoice.number}</span>
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${
                      invoice.status === 'paid'
                        ? 'bg-success/20 text-success'
                        : invoice.status === 'open'
                        ? 'bg-amber-400/20 text-amber-400'
                        : 'bg-error/20 text-error'
                    }`}
                  >
                    {invoice.status}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-muted">{new Date(invoice.date).toLocaleDateString()}</span>
                  <span className="text-text-primary font-medium">${(invoice.amount / 100).toFixed(2)}</span>
                </div>
                {invoice.pdfUrl && (
                  <a
                    href={invoice.pdfUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 block text-center text-xs text-accent-cyan py-2 border border-accent-cyan/30 rounded-lg hover:bg-accent-cyan/10 transition-colors"
                  >
                    Download PDF
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Icons
function LoadingSpinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-accent-cyan" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
