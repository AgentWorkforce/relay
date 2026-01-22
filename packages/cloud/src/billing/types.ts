/**
 * Agent Relay Cloud - Billing Types
 *
 * Defines subscription plans, customer data, and billing events.
 */

/**
 * Subscription tier levels
 */
export type SubscriptionTier = 'free' | 'pro' | 'team' | 'enterprise';

/**
 * Plan definitions with limits and pricing
 */
export interface BillingPlan {
  id: SubscriptionTier;
  name: string;
  description: string;
  priceMonthly: number; // cents
  priceYearly: number; // cents
  stripePriceIdMonthly?: string;
  stripePriceIdYearly?: string;
  limits: BillingPlanLimits;
  features: string[];
}

/**
 * Resource limits per plan for billing/display purposes.
 * These limits are shown to customers on pricing pages and in account settings.
 *
 * Note: For runtime limit checking (API enforcement), use PlanLimits from
 * src/cloud/services/planLimits.ts which has a focused subset of limits.
 */
export interface BillingPlanLimits {
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
  /** Cloud session persistence (summaries, session tracking) - Pro+ only */
  sessionPersistence: boolean;
}

/**
 * Customer billing information
 */
export interface BillingCustomer {
  id: string; // Internal user ID
  stripeCustomerId: string;
  email: string;
  name?: string;
  subscription?: CustomerSubscription;
  paymentMethods: PaymentMethod[];
  invoices: Invoice[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Active subscription
 */
export interface CustomerSubscription {
  id: string;
  stripeSubscriptionId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  billingInterval: 'month' | 'year';
  createdAt: Date;
}

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'trialing'
  | 'unpaid';

/**
 * Payment method
 */
export interface PaymentMethod {
  id: string;
  stripePaymentMethodId: string;
  type: 'card' | 'us_bank_account' | 'sepa_debit';
  isDefault: boolean;
  card?: {
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
  };
}

/**
 * Invoice
 */
export interface Invoice {
  id: string;
  stripeInvoiceId: string;
  amountDue: number;
  amountPaid: number;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  invoicePdf?: string;
  hostedInvoiceUrl?: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
}

/**
 * Usage record for metered billing
 */
export interface UsageRecord {
  userId: string;
  workspaceId: string;
  metric: UsageMetric;
  quantity: number;
  timestamp: Date;
}

export type UsageMetric =
  | 'compute_hours'
  | 'storage_gb'
  | 'api_calls'
  | 'agent_spawns';

/**
 * Billing event for webhooks and audit
 */
export interface BillingEvent {
  id: string;
  type: BillingEventType;
  userId?: string;
  stripeEventId?: string;
  data: Record<string, unknown>;
  processedAt?: Date;
  createdAt: Date;
}

export type BillingEventType =
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'subscription.trial_ending'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'payment_method.attached'
  | 'payment_method.detached'
  | 'customer.created'
  | 'customer.updated';

/**
 * Checkout session result
 */
export interface CheckoutSession {
  sessionId: string;
  url: string;
}

/**
 * Portal session for managing subscription
 */
export interface PortalSession {
  url: string;
}
