/**
 * Agent Relay Cloud - Billing Service
 *
 * Stripe integration for subscription management, payments, and webhooks.
 */

import Stripe from 'stripe';
import { getConfig } from '../config.js';
import { getPlan } from './plans.js';
import type {
  SubscriptionTier,
  BillingCustomer,
  CustomerSubscription,
  PaymentMethod,
  Invoice,
  CheckoutSession,
  PortalSession,
  BillingEvent,
  SubscriptionStatus,
} from './types.js';

let stripeClient: Stripe | null = null;

/**
 * Get or create Stripe client
 */
function getStripe(): Stripe {
  if (!stripeClient) {
    const config = getConfig();
    stripeClient = new Stripe(config.stripe.secretKey);
  }
  return stripeClient;
}

/**
 * Billing Service
 */
export class BillingService {
  private stripe: Stripe;

  constructor() {
    this.stripe = getStripe();
  }

  /**
   * Create or get a Stripe customer for a user
   */
  async getOrCreateCustomer(
    userId: string,
    email: string,
    name?: string
  ): Promise<string> {
    // Search for existing customer by metadata
    const existing = await this.stripe.customers.search({
      query: `metadata['user_id']:'${userId}'`,
      limit: 1,
    });

    if (existing.data.length > 0) {
      return existing.data[0].id;
    }

    // Create new customer
    const customer = await this.stripe.customers.create({
      email,
      name,
      metadata: {
        user_id: userId,
      },
    });

    return customer.id;
  }

  /**
   * Get customer details including subscription
   */
  async getCustomer(stripeCustomerId: string): Promise<BillingCustomer | null> {
    try {
      const customer = await this.stripe.customers.retrieve(stripeCustomerId, {
        expand: ['subscriptions', 'invoice_settings.default_payment_method'],
      });

      if (customer.deleted) {
        return null;
      }

      // Get payment methods
      const paymentMethods = await this.stripe.paymentMethods.list({
        customer: stripeCustomerId,
        type: 'card',
      });

      // Get recent invoices
      const invoices = await this.stripe.invoices.list({
        customer: stripeCustomerId,
        limit: 10,
      });

      const subscription = (customer as Stripe.Customer).subscriptions?.data[0];

      return {
        id: customer.metadata?.user_id || '',
        stripeCustomerId,
        email: (customer as Stripe.Customer).email || '',
        name: (customer as Stripe.Customer).name || undefined,
        subscription: subscription ? this.mapSubscription(subscription) : undefined,
        paymentMethods: paymentMethods.data.map((pm: Stripe.PaymentMethod) => this.mapPaymentMethod(pm)),
        invoices: invoices.data.map((inv: Stripe.Invoice) => this.mapInvoice(inv)),
        createdAt: new Date((customer as Stripe.Customer).created * 1000),
        updatedAt: new Date(),
      };
    } catch (error) {
      if ((error as Stripe.errors.StripeError).code === 'resource_missing') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a checkout session for subscription
   */
  async createCheckoutSession(
    customerId: string,
    tier: SubscriptionTier,
    billingInterval: 'month' | 'year',
    successUrl: string,
    cancelUrl: string
  ): Promise<CheckoutSession> {
    const config = getConfig();
    // Validate tier exists
    getPlan(tier);

    // Get the appropriate price ID
    let priceId: string | undefined;
    if (billingInterval === 'month') {
      priceId = config.stripe.priceIds[`${tier}Monthly` as keyof typeof config.stripe.priceIds];
    } else {
      priceId = config.stripe.priceIds[`${tier}Yearly` as keyof typeof config.stripe.priceIds];
    }

    if (!priceId) {
      throw new Error(`No price configured for ${tier} ${billingInterval}ly plan`);
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: {
          tier,
        },
      },
      allow_promotion_codes: true,
    });

    return {
      sessionId: session.id,
      url: session.url!,
    };
  }

  /**
   * Create a billing portal session for managing subscription
   */
  async createPortalSession(
    customerId: string,
    returnUrl: string
  ): Promise<PortalSession> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return {
      url: session.url,
    };
  }

  /**
   * Change subscription tier
   */
  async changeSubscription(
    subscriptionId: string,
    newTier: SubscriptionTier,
    billingInterval: 'month' | 'year'
  ): Promise<CustomerSubscription> {
    const config = getConfig();

    // Get new price ID
    let priceId: string | undefined;
    if (billingInterval === 'month') {
      priceId = config.stripe.priceIds[`${newTier}Monthly` as keyof typeof config.stripe.priceIds];
    } else {
      priceId = config.stripe.priceIds[`${newTier}Yearly` as keyof typeof config.stripe.priceIds];
    }

    if (!priceId) {
      throw new Error(`No price configured for ${newTier} ${billingInterval}ly plan`);
    }

    // Get current subscription
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const currentItem = subscription.items.data[0];

    // Update subscription
    const updated = await this.stripe.subscriptions.update(subscriptionId, {
      items: [
        {
          id: currentItem.id,
          price: priceId,
        },
      ],
      metadata: {
        tier: newTier,
      },
      proration_behavior: 'create_prorations',
    });

    return this.mapSubscription(updated);
  }

  /**
   * Cancel subscription at period end
   */
  async cancelSubscription(subscriptionId: string): Promise<CustomerSubscription> {
    const subscription = await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });

    return this.mapSubscription(subscription);
  }

  /**
   * Resume a canceled subscription
   */
  async resumeSubscription(subscriptionId: string): Promise<CustomerSubscription> {
    const subscription = await this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    return this.mapSubscription(subscription);
  }

  /**
   * Add a payment method to customer
   */
  async addPaymentMethod(
    customerId: string,
    paymentMethodId: string,
    setAsDefault: boolean = false
  ): Promise<PaymentMethod> {
    // Attach payment method to customer
    const pm = await this.stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });

    // Set as default if requested
    if (setAsDefault) {
      await this.stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId,
        },
      });
    }

    return this.mapPaymentMethod(pm, setAsDefault);
  }

  /**
   * Remove a payment method
   */
  async removePaymentMethod(paymentMethodId: string): Promise<void> {
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  /**
   * Set default payment method
   */
  async setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string
  ): Promise<void> {
    await this.stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });
  }

  /**
   * Get upcoming invoice preview
   */
  async getUpcomingInvoice(customerId: string): Promise<Invoice | null> {
    try {
      const invoice = await (this.stripe.invoices as any).retrieveUpcoming({
        customer: customerId,
      });

      return this.mapInvoice(invoice);
    } catch (error) {
      if ((error as Stripe.errors.StripeError).code === 'invoice_upcoming_none') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Record usage for metered billing
   */
  async recordUsage(
    subscriptionItemId: string,
    quantity: number,
    timestamp?: Date
  ): Promise<void> {
    await (this.stripe.subscriptionItems as any).createUsageRecord(subscriptionItemId, {
      quantity,
      timestamp: timestamp ? Math.floor(timestamp.getTime() / 1000) : undefined,
      action: 'increment',
    });
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string | Buffer, signature: string): Stripe.Event {
    const config = getConfig();
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      config.stripe.webhookSecret
    );
  }

  /**
   * Process webhook event
   */
  async processWebhookEvent(event: Stripe.Event): Promise<BillingEvent> {
    const billingEvent: BillingEvent = {
      id: event.id,
      type: this.mapEventType(event.type),
      stripeEventId: event.id,
      data: event.data.object as unknown as Record<string, unknown>,
      createdAt: new Date(event.created * 1000),
    };

    // Extract user ID from customer metadata if available
    if ('customer' in event.data.object) {
      const customerId = event.data.object.customer as string;
      if (customerId) {
        try {
          const customer = await this.stripe.customers.retrieve(customerId);
          if (!customer.deleted && customer.metadata?.user_id) {
            billingEvent.userId = customer.metadata.user_id;
          }
        } catch {
          // Customer not found, continue without user ID
        }
      }
    }

    billingEvent.processedAt = new Date();
    return billingEvent as BillingEvent;
  }

  /**
   * Get subscription tier from Stripe subscription
   */
  getTierFromSubscription(subscription: Stripe.Subscription): SubscriptionTier {
    // Check metadata first
    if (subscription.metadata?.tier) {
      return subscription.metadata.tier as SubscriptionTier;
    }

    // Fallback: determine from price ID
    const config = getConfig();
    const priceId = subscription.items.data[0]?.price.id;

    for (const [key, value] of Object.entries(config.stripe.priceIds)) {
      if (value === priceId) {
        // Extract tier from key (e.g., 'proMonthly' -> 'pro')
        return key.replace(/(Monthly|Yearly)$/, '').toLowerCase() as SubscriptionTier;
      }
    }

    return 'free'; // Default fallback
  }

  // Helper: Map Stripe subscription to our type
  private mapSubscription(subscription: Stripe.Subscription): CustomerSubscription {
    const sub = subscription as any;
    return {
      id: subscription.id,
      stripeSubscriptionId: subscription.id,
      tier: this.getTierFromSubscription(subscription),
      status: subscription.status as SubscriptionStatus,
      currentPeriodStart: new Date((sub.current_period_start || sub.billing_cycle_anchor) * 1000),
      currentPeriodEnd: new Date((sub.current_period_end || sub.current_period_start + 30 * 24 * 60 * 60) * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      billingInterval: subscription.items.data[0]?.price.recurring?.interval === 'year'
        ? 'year'
        : 'month',
      createdAt: new Date(subscription.created * 1000),
    };
  }

  // Helper: Map Stripe payment method to our type
  private mapPaymentMethod(pm: Stripe.PaymentMethod, isDefault = false): PaymentMethod {
    return {
      id: pm.id,
      stripePaymentMethodId: pm.id,
      type: pm.type as 'card' | 'us_bank_account' | 'sepa_debit',
      isDefault,
      card: pm.card
        ? {
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year,
          }
        : undefined,
    };
  }

  // Helper: Map Stripe invoice to our type
  private mapInvoice(invoice: Stripe.Invoice | Stripe.UpcomingInvoice): Invoice {
    const isUpcoming = !('id' in invoice) || invoice.id === null;

    return {
      id: isUpcoming ? 'upcoming' : invoice.id!,
      stripeInvoiceId: isUpcoming ? 'upcoming' : invoice.id!,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      status: isUpcoming ? 'draft' : (invoice.status as Invoice['status']),
      invoicePdf: 'invoice_pdf' in invoice ? invoice.invoice_pdf ?? undefined : undefined,
      hostedInvoiceUrl: 'hosted_invoice_url' in invoice ? invoice.hosted_invoice_url ?? undefined : undefined,
      periodStart: new Date(invoice.period_start * 1000),
      periodEnd: new Date(invoice.period_end * 1000),
      createdAt: new Date((invoice.created || Date.now() / 1000) * 1000),
    };
  }

  // Helper: Map Stripe event type to our type
  private mapEventType(stripeType: string): BillingEvent['type'] {
    const mapping: Record<string, BillingEvent['type']> = {
      'customer.subscription.created': 'subscription.created',
      'customer.subscription.updated': 'subscription.updated',
      'customer.subscription.deleted': 'subscription.canceled',
      'customer.subscription.trial_will_end': 'subscription.trial_ending',
      'invoice.paid': 'invoice.paid',
      'invoice.payment_failed': 'invoice.payment_failed',
      'payment_method.attached': 'payment_method.attached',
      'payment_method.detached': 'payment_method.detached',
      'customer.created': 'customer.created',
      'customer.updated': 'customer.updated',
    };

    return mapping[stripeType] || 'customer.updated';
  }
}

// Export singleton instance
let billingService: BillingService | null = null;

export function getBillingService(): BillingService {
  if (!billingService) {
    billingService = new BillingService();
  }
  return billingService;
}
