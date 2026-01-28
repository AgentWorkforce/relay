/**
 * Pricing Plans Component
 *
 * Displays available subscription plans with features and pricing.
 */

import React, { useState } from 'react';

export interface Plan {
  id: string;
  name: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  limits: {
    maxWorkspaces: number;
    maxAgentsPerWorkspace: number;
    maxTeamMembers: number;
    maxStorageGB: number;
    maxComputeHoursPerMonth: number;
    customDomains: boolean;
    prioritySupport: boolean;
    sla: boolean;
    ssoEnabled: boolean;
    auditLogs: boolean;
  };
  features: string[];
}

export interface PricingPlansProps {
  plans: Plan[];
  currentPlan?: string;
  onSelectPlan: (planId: string, interval: 'month' | 'year') => void;
  isLoading?: boolean;
}

export function PricingPlans({
  plans,
  currentPlan = 'free',
  onSelectPlan,
  isLoading = false,
}: PricingPlansProps) {
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month');

  const formatPrice = (cents: number) => {
    if (cents === 0) return 'Free';
    return `$${(cents / 100).toFixed(0)}`;
  };

  const formatLimit = (value: number) => {
    if (value === -1) return 'Unlimited';
    return value.toString();
  };

  return (
    <div className="pricing-plans">
      {/* Billing Toggle */}
      <div className="billing-toggle">
        <button
          className={`toggle-btn ${billingInterval === 'month' ? 'active' : ''}`}
          onClick={() => setBillingInterval('month')}
        >
          Monthly
        </button>
        <button
          className={`toggle-btn ${billingInterval === 'year' ? 'active' : ''}`}
          onClick={() => setBillingInterval('year')}
        >
          Yearly
          <span className="save-badge">Save 17%</span>
        </button>
      </div>

      {/* Plans Grid */}
      <div className="plans-grid">
        {plans.map((plan) => {
          const isCurrent = plan.id === currentPlan;
          const price = billingInterval === 'month' ? plan.priceMonthly : plan.priceYearly;
          const monthlyEquivalent = billingInterval === 'year' ? plan.priceYearly / 12 : plan.priceMonthly;

          return (
            <div
              key={plan.id}
              className={`plan-card ${isCurrent ? 'current' : ''} ${plan.id === 'pro' ? 'popular' : ''}`}
            >
              {plan.id === 'pro' && <div className="popular-badge">Most Popular</div>}
              {isCurrent && <div className="current-badge">Current Plan</div>}

              <div className="plan-header">
                <h3 className="plan-name">{plan.name}</h3>
                <p className="plan-description">{plan.description}</p>
              </div>

              <div className="plan-pricing">
                <span className="plan-price">{formatPrice(monthlyEquivalent)}</span>
                {price > 0 && (
                  <span className="plan-period">
                    /month{billingInterval === 'year' && ', billed yearly'}
                  </span>
                )}
              </div>

              <ul className="plan-features">
                {plan.features.map((feature, i) => (
                  <li key={i}>
                    <CheckIcon />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="plan-limits">
                <div className="limit-item">
                  <span className="limit-label">Workspaces</span>
                  <span className="limit-value">{formatLimit(plan.limits.maxWorkspaces)}</span>
                </div>
                <div className="limit-item">
                  <span className="limit-label">Agents/Workspace</span>
                  <span className="limit-value">{formatLimit(plan.limits.maxAgentsPerWorkspace)}</span>
                </div>
                <div className="limit-item">
                  <span className="limit-label">Team Members</span>
                  <span className="limit-value">{formatLimit(plan.limits.maxTeamMembers)}</span>
                </div>
                <div className="limit-item">
                  <span className="limit-label">Storage</span>
                  <span className="limit-value">{formatLimit(plan.limits.maxStorageGB)} GB</span>
                </div>
              </div>

              <button
                className={`plan-button ${isCurrent ? 'current' : ''} ${plan.id === 'free' ? 'free' : ''}`}
                onClick={() => onSelectPlan(plan.id, billingInterval)}
                disabled={isCurrent || isLoading}
              >
                {isLoading ? (
                  'Loading...'
                ) : isCurrent ? (
                  'Current Plan'
                ) : plan.id === 'free' ? (
                  'Downgrade'
                ) : plan.id === 'enterprise' ? (
                  'Contact Sales'
                ) : (
                  'Upgrade'
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export const pricingPlansStyles = `
.pricing-plans {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.billing-toggle {
  display: flex;
  justify-content: center;
  gap: 4px;
  margin-bottom: 32px;
  background: #2a2a3e;
  padding: 4px;
  border-radius: 8px;
  width: fit-content;
  margin-left: auto;
  margin-right: auto;
}

.toggle-btn {
  padding: 10px 20px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: #8d8d8e;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle-btn.active {
  background: #00c896;
  color: #1a1a2e;
}

.save-badge {
  font-size: 11px;
  padding: 2px 6px;
  background: rgba(0, 200, 150, 0.2);
  border-radius: 4px;
  color: #00c896;
}

.toggle-btn.active .save-badge {
  background: rgba(26, 26, 46, 0.3);
  color: #1a1a2e;
}

.plans-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 24px;
}

.plan-card {
  background: #1a1a2e;
  border: 1px solid #2a2a3e;
  border-radius: 12px;
  padding: 24px;
  position: relative;
  transition: all 0.2s;
}

.plan-card:hover {
  border-color: #3a3a4e;
}

.plan-card.popular {
  border-color: #00c896;
}

.plan-card.current {
  border-color: #1264a3;
}

.popular-badge,
.current-badge {
  position: absolute;
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.popular-badge {
  background: #00c896;
  color: #1a1a2e;
}

.current-badge {
  background: #1264a3;
  color: white;
}

.plan-header {
  margin-bottom: 20px;
}

.plan-name {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
  color: #e8e8e8;
}

.plan-description {
  margin: 0;
  font-size: 14px;
  color: #8d8d8e;
}

.plan-pricing {
  margin-bottom: 24px;
}

.plan-price {
  font-size: 36px;
  font-weight: 700;
  color: #e8e8e8;
}

.plan-period {
  font-size: 14px;
  color: #8d8d8e;
  margin-left: 4px;
}

.plan-features {
  list-style: none;
  padding: 0;
  margin: 0 0 24px;
}

.plan-features li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  font-size: 14px;
  color: #b8b8b8;
}

.plan-features li svg {
  color: #00c896;
  flex-shrink: 0;
  margin-top: 2px;
}

.plan-limits {
  padding: 16px 0;
  border-top: 1px solid #2a2a3e;
  margin-bottom: 24px;
}

.limit-item {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  font-size: 13px;
}

.limit-label {
  color: #8d8d8e;
}

.limit-value {
  color: #e8e8e8;
  font-weight: 500;
}

.plan-button {
  width: 100%;
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  background: #00c896;
  color: #1a1a2e;
}

.plan-button:hover:not(:disabled) {
  background: #00a87d;
}

.plan-button.current {
  background: #2a2a3e;
  color: #8d8d8e;
  cursor: default;
}

.plan-button.free {
  background: transparent;
  border: 1px solid #3a3a4e;
  color: #8d8d8e;
}

.plan-button.free:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
  border-color: #4a4a5e;
}

.plan-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .plans-grid {
    grid-template-columns: 1fr;
  }
}
`;
