/**
 * Billing Panel Component
 *
 * Shows current subscription status, usage, and billing management options.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { PricingPlans, type Plan } from './PricingPlans';

export interface Subscription {
  id: string;
  tier: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  billingInterval: 'month' | 'year';
}

export interface Invoice {
  id: string;
  amountDue: number;
  amountPaid: number;
  status: string;
  invoicePdf?: string;
  hostedInvoiceUrl?: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
}

export interface PaymentMethod {
  id: string;
  type: string;
  isDefault: boolean;
  card?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  };
}

export interface BillingPanelProps {
  apiUrl?: string;
  onClose?: () => void;
}

export function BillingPanel({ apiUrl = '/api/billing', onClose }: BillingPanelProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'plans' | 'invoices'>('overview');
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch billing data
  const fetchBillingData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Fetch plans
      const plansResponse = await fetch(`${apiUrl}/plans`);
      const plansData = await plansResponse.json();
      setPlans(plansData.plans);

      // Fetch subscription
      const subResponse = await fetch(`${apiUrl}/subscription`);
      const subData = await subResponse.json();
      if (subData.subscription) {
        setSubscription({
          ...subData.subscription,
          currentPeriodStart: new Date(subData.subscription.currentPeriodStart),
          currentPeriodEnd: new Date(subData.subscription.currentPeriodEnd),
        });
      }
      if (subData.customer?.paymentMethods) {
        setPaymentMethods(subData.customer.paymentMethods);
      }
      if (subData.customer?.invoices) {
        setInvoices(
          subData.customer.invoices.map((inv: Invoice) => ({
            ...inv,
            periodStart: new Date(inv.periodStart),
            periodEnd: new Date(inv.periodEnd),
            createdAt: new Date(inv.createdAt),
          }))
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load billing data');
    } finally {
      setIsLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    fetchBillingData();
  }, [fetchBillingData]);

  // Handle plan selection
  const handleSelectPlan = async (planId: string, interval: 'month' | 'year') => {
    if (planId === 'enterprise') {
      // Redirect to contact sales
      window.open('mailto:sales@agent-relay.com?subject=Enterprise%20Plan%20Inquiry', '_blank');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      // Check if upgrading or changing plan
      if (subscription && planId !== 'free') {
        // Change existing subscription
        const response = await fetch(`${apiUrl}/change`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier: planId, interval }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to change subscription');
        }

        await fetchBillingData();
      } else if (planId === 'free' && subscription) {
        // Cancel subscription
        const response = await fetch(`${apiUrl}/cancel`, {
          method: 'POST',
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to cancel subscription');
        }

        await fetchBillingData();
      } else {
        // Create new subscription via checkout
        const response = await fetch(`${apiUrl}/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier: planId, interval }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to create checkout session');
        }

        const { url } = await response.json();
        window.location.href = url;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle resume subscription
  const handleResumeSubscription = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/resume`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to resume subscription');
      }

      await fetchBillingData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle open billing portal
  const handleOpenPortal = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      const response = await fetch(`${apiUrl}/portal`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to open billing portal');
      }

      const { url } = await response.json();
      window.open(url, '_blank');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsProcessing(false);
    }
  };

  const currentTier = subscription?.tier || 'free';
  const currentPlan = plans.find((p) => p.id === currentTier);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const formatAmount = (cents: number) => {
    return `$${(cents / 100).toFixed(2)}`;
  };

  if (isLoading) {
    return (
      <div className="billing-panel">
        <div className="billing-loading">
          <LoadingSpinner />
          <p>Loading billing information...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="billing-panel">
      {/* Header */}
      <div className="billing-header">
        <h2>Billing & Subscription</h2>
        {onClose && (
          <button className="billing-close" onClick={onClose}>
            <CloseIcon />
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="billing-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>&times;</button>
        </div>
      )}

      {/* Tabs */}
      <div className="billing-tabs">
        <button
          className={`billing-tab ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`billing-tab ${activeTab === 'plans' ? 'active' : ''}`}
          onClick={() => setActiveTab('plans')}
        >
          Plans
        </button>
        <button
          className={`billing-tab ${activeTab === 'invoices' ? 'active' : ''}`}
          onClick={() => setActiveTab('invoices')}
        >
          Invoices
        </button>
      </div>

      {/* Tab Content */}
      <div className="billing-content">
        {activeTab === 'overview' && (
          <div className="billing-overview">
            {/* Current Plan */}
            <div className="overview-section">
              <h3>Current Plan</h3>
              <div className="current-plan-card">
                <div className="plan-info">
                  <span className="plan-name">{currentPlan?.name || 'Free'}</span>
                  <span className="plan-tier-badge">{currentTier}</span>
                </div>
                {subscription && (
                  <div className="plan-details">
                    <p>
                      <strong>Status:</strong>{' '}
                      <span className={`status-${subscription.status}`}>
                        {subscription.status}
                      </span>
                    </p>
                    <p>
                      <strong>Billing:</strong> {subscription.billingInterval === 'year' ? 'Annual' : 'Monthly'}
                    </p>
                    <p>
                      <strong>Current Period:</strong>{' '}
                      {formatDate(subscription.currentPeriodStart)} - {formatDate(subscription.currentPeriodEnd)}
                    </p>
                    {subscription.cancelAtPeriodEnd && (
                      <div className="cancel-notice">
                        <p>Your subscription will be canceled on {formatDate(subscription.currentPeriodEnd)}</p>
                        <button
                          className="btn-resume"
                          onClick={handleResumeSubscription}
                          disabled={isProcessing}
                        >
                          {isProcessing ? 'Processing...' : 'Resume Subscription'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {!subscription && (
                  <p className="free-notice">
                    You're on the free plan. Upgrade to unlock more features!
                  </p>
                )}
              </div>
            </div>

            {/* Usage */}
            {currentPlan && (
              <div className="overview-section">
                <h3>Usage & Limits</h3>
                <div className="usage-grid">
                  <UsageItem
                    label="Workspaces"
                    current={0}
                    limit={currentPlan.limits.maxWorkspaces}
                  />
                  <UsageItem
                    label="Agents per Workspace"
                    current={0}
                    limit={currentPlan.limits.maxAgentsPerWorkspace}
                  />
                  <UsageItem
                    label="Team Members"
                    current={1}
                    limit={currentPlan.limits.maxTeamMembers}
                  />
                  <UsageItem
                    label="Storage"
                    current={0}
                    limit={currentPlan.limits.maxStorageGB}
                    unit="GB"
                  />
                  <UsageItem
                    label="Compute Hours"
                    current={0}
                    limit={currentPlan.limits.maxComputeHoursPerMonth}
                    unit="hrs/mo"
                  />
                </div>
              </div>
            )}

            {/* Payment Method */}
            {paymentMethods.length > 0 && (
              <div className="overview-section">
                <h3>Payment Method</h3>
                <div className="payment-methods">
                  {paymentMethods.map((pm) => (
                    <div key={pm.id} className={`payment-method ${pm.isDefault ? 'default' : ''}`}>
                      {pm.card && (
                        <>
                          <CardIcon brand={pm.card.brand} />
                          <span className="card-info">
                            {pm.card.brand.charAt(0).toUpperCase() + pm.card.brand.slice(1)} •••• {pm.card.last4}
                          </span>
                          <span className="card-expiry">
                            Expires {pm.card.expMonth}/{pm.card.expYear}
                          </span>
                          {pm.isDefault && <span className="default-badge">Default</span>}
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <button className="btn-manage-billing" onClick={handleOpenPortal} disabled={isProcessing}>
                  {isProcessing ? 'Opening...' : 'Manage Payment Methods'}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'plans' && (
          <PricingPlans
            plans={plans}
            currentPlan={currentTier}
            onSelectPlan={handleSelectPlan}
            isLoading={isProcessing}
          />
        )}

        {activeTab === 'invoices' && (
          <div className="billing-invoices">
            {invoices.length === 0 ? (
              <div className="no-invoices">
                <p>No invoices yet</p>
              </div>
            ) : (
              <table className="invoices-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Period</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>{formatDate(invoice.createdAt)}</td>
                      <td>
                        {formatDate(invoice.periodStart)} - {formatDate(invoice.periodEnd)}
                      </td>
                      <td>{formatAmount(invoice.amountPaid || invoice.amountDue)}</td>
                      <td>
                        <span className={`invoice-status status-${invoice.status}`}>
                          {invoice.status}
                        </span>
                      </td>
                      <td>
                        {invoice.invoicePdf && (
                          <a href={invoice.invoicePdf} target="_blank" rel="noopener noreferrer">
                            PDF
                          </a>
                        )}
                        {invoice.hostedInvoiceUrl && (
                          <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">
                            View
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Helper components
function UsageItem({
  label,
  current,
  limit,
  unit,
}: {
  label: string;
  current: number;
  limit: number;
  unit?: string;
}) {
  const isUnlimited = limit === -1;
  const percentage = isUnlimited ? 0 : (current / limit) * 100;

  return (
    <div className="usage-item">
      <div className="usage-header">
        <span className="usage-label">{label}</span>
        <span className="usage-value">
          {current}{unit ? ` ${unit}` : ''} / {isUnlimited ? 'Unlimited' : `${limit}${unit ? ` ${unit}` : ''}`}
        </span>
      </div>
      <div className="usage-bar">
        <div
          className={`usage-fill ${percentage > 80 ? 'warning' : ''} ${percentage > 95 ? 'critical' : ''}`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  );
}

function CardIcon({ brand }: { brand: string }) {
  return (
    <svg width="32" height="24" viewBox="0 0 32 24" fill="none" className="card-icon">
      <rect width="32" height="24" rx="4" fill="#2a2a3e" />
      <text x="16" y="14" textAnchor="middle" fill="#8d8d8e" fontSize="8">
        {brand.toUpperCase()}
      </text>
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <svg className="spinner" width="24" height="24" viewBox="0 0 24 24">
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

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export const billingPanelStyles = `
.billing-panel {
  background: #1a1a2e;
  border: 1px solid #2a2a3e;
  border-radius: 12px;
  max-width: 1000px;
  margin: 0 auto;
  overflow: hidden;
}

.billing-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid #2a2a3e;
}

.billing-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #e8e8e8;
}

.billing-close {
  background: transparent;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 4px;
  display: flex;
  border-radius: 4px;
  transition: all 0.2s;
}

.billing-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #e8e8e8;
}

.billing-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 24px;
  color: #8d8d8e;
}

.billing-loading .spinner {
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
  color: #00c896;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.billing-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: rgba(239, 68, 68, 0.1);
  border-bottom: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
  font-size: 14px;
}

.billing-error button {
  background: none;
  border: none;
  color: #ef4444;
  cursor: pointer;
  font-size: 18px;
}

.billing-tabs {
  display: flex;
  border-bottom: 1px solid #2a2a3e;
}

.billing-tab {
  flex: 1;
  padding: 14px 20px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #8d8d8e;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.billing-tab:hover {
  color: #e8e8e8;
  background: rgba(255, 255, 255, 0.02);
}

.billing-tab.active {
  color: #00c896;
  border-bottom-color: #00c896;
}

.billing-content {
  padding: 24px;
}

.billing-overview {
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.overview-section h3 {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
  color: #e8e8e8;
}

.current-plan-card {
  background: #222234;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
  padding: 20px;
}

.plan-info {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.plan-info .plan-name {
  font-size: 20px;
  font-weight: 600;
  color: #e8e8e8;
}

.plan-tier-badge {
  padding: 4px 10px;
  background: #00c896;
  color: #1a1a2e;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  text-transform: capitalize;
}

.plan-details p {
  margin: 8px 0;
  font-size: 14px;
  color: #b8b8b8;
}

.plan-details strong {
  color: #e8e8e8;
}

.status-active { color: #00c896; }
.status-past_due { color: #f59e0b; }
.status-canceled { color: #ef4444; }
.status-trialing { color: #3b82f6; }

.cancel-notice {
  margin-top: 16px;
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
}

.cancel-notice p {
  color: #ef4444;
  margin-bottom: 12px;
}

.btn-resume {
  padding: 8px 16px;
  background: #00c896;
  color: #1a1a2e;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-resume:hover:not(:disabled) {
  background: #00a87d;
}

.btn-resume:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.free-notice {
  color: #8d8d8e;
  font-size: 14px;
}

.usage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.usage-item {
  background: #222234;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
  padding: 16px;
}

.usage-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.usage-label {
  font-size: 13px;
  color: #8d8d8e;
}

.usage-value {
  font-size: 13px;
  color: #e8e8e8;
  font-weight: 500;
}

.usage-bar {
  height: 6px;
  background: #2a2a3e;
  border-radius: 3px;
  overflow: hidden;
}

.usage-fill {
  height: 100%;
  background: #00c896;
  border-radius: 3px;
  transition: width 0.3s;
}

.usage-fill.warning {
  background: #f59e0b;
}

.usage-fill.critical {
  background: #ef4444;
}

.payment-methods {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.payment-method {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #222234;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
}

.payment-method.default {
  border-color: #00c896;
}

.card-icon {
  flex-shrink: 0;
}

.card-info {
  font-size: 14px;
  color: #e8e8e8;
}

.card-expiry {
  font-size: 12px;
  color: #8d8d8e;
  margin-left: auto;
}

.default-badge {
  padding: 2px 8px;
  background: #00c896;
  color: #1a1a2e;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.btn-manage-billing {
  padding: 10px 16px;
  background: transparent;
  border: 1px solid #3a3a4e;
  border-radius: 6px;
  color: #e8e8e8;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-manage-billing:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
  border-color: #4a4a5e;
}

.btn-manage-billing:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.billing-invoices {
  min-height: 200px;
}

.no-invoices {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px;
  color: #8d8d8e;
}

.invoices-table {
  width: 100%;
  border-collapse: collapse;
}

.invoices-table th,
.invoices-table td {
  padding: 12px 16px;
  text-align: left;
  border-bottom: 1px solid #2a2a3e;
}

.invoices-table th {
  font-size: 12px;
  font-weight: 500;
  color: #8d8d8e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.invoices-table td {
  font-size: 14px;
  color: #e8e8e8;
}

.invoice-status {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  text-transform: capitalize;
}

.invoice-status.status-paid {
  background: rgba(0, 200, 150, 0.1);
  color: #00c896;
}

.invoice-status.status-open {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.invoice-status.status-void {
  background: rgba(107, 114, 128, 0.1);
  color: #6b7280;
}

.invoices-table a {
  color: #00c896;
  text-decoration: none;
  margin-right: 12px;
}

.invoices-table a:hover {
  text-decoration: underline;
}
`;
