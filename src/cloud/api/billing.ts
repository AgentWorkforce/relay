/**
 * Agent Relay Cloud - Billing API
 *
 * REST API for subscription and billing management.
 */

import { Router, Request } from 'express';
import { getBillingService, getAllPlans, getPlan, comparePlans } from '../billing/index.js';
import type { SubscriptionTier } from '../billing/types.js';
import { getConfig, isAdminUser } from '../config.js';
import { db, type PlanType } from '../db/index.js';
import { requireAuth } from './auth.js';
import { getProvisioner, RESOURCE_TIERS } from '../provisioner/index.js';
import { getResourceTierForPlan } from '../services/planLimits.js';
import type Stripe from 'stripe';

export const billingRouter = Router();

/**
 * Get the count of connected agents in a running workspace
 * Returns 0 if workspace is not reachable or has no agents
 */
async function getWorkspaceAgentCount(publicUrl: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${publicUrl}/agents`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return 0;

    const data = await response.json() as { agents?: unknown[] };
    return data.agents?.length ?? 0;
  } catch {
    // Workspace not reachable or error - assume no agents
    return 0;
  }
}

interface ResizeResult {
  resized: number;
  deferred: Array<{ workspaceId: string; workspaceName: string; agentCount: number }>;
  failed: number;
}

/**
 * Resize user's workspaces to match their new plan tier
 * Called after plan upgrade/downgrade to adjust compute resources
 *
 * Strategy:
 * - Stopped workspaces: Resize immediately (no disruption)
 * - Running workspaces with no agents: Resize immediately (safe to restart)
 * - Running workspaces with agents: Save config for next restart (no agent disruption)
 *
 * Returns info about which workspaces were deferred so we can inform the user.
 */
async function resizeWorkspacesForPlan(userId: string, newPlan: PlanType): Promise<ResizeResult> {
  const result: ResizeResult = { resized: 0, deferred: [], failed: 0 };

  try {
    const workspaces = await db.workspaces.findByUserId(userId);
    if (workspaces.length === 0) return result;

    const provisioner = getProvisioner();
    const targetTierName = getResourceTierForPlan(newPlan);
    const targetTier = RESOURCE_TIERS[targetTierName];

    console.log(`[billing] Upgrading ${workspaces.length} workspace(s) for user ${userId.substring(0, 8)} to ${targetTierName}`);

    for (const workspace of workspaces) {
      if (workspace.status !== 'running' && workspace.status !== 'stopped') {
        console.log(`[billing] Skipping workspace ${workspace.id.substring(0, 8)} (status: ${workspace.status})`);
        continue;
      }

      try {
        let skipRestart = false;
        let agentCount = 0;

        // For running workspaces: check if there are active agents
        if (workspace.status === 'running' && workspace.publicUrl) {
          agentCount = await getWorkspaceAgentCount(workspace.publicUrl);

          if (agentCount > 0) {
            // Has active agents - don't disrupt them
            skipRestart = true;
            console.log(`[billing] Workspace ${workspace.id.substring(0, 8)} has ${agentCount} active agent(s), deferring resize`);
          } else {
            // No active agents - safe to restart immediately
            console.log(`[billing] Workspace ${workspace.id.substring(0, 8)} has no active agents, proceeding with immediate resize`);
          }
        }

        await provisioner.resize(workspace.id, targetTier, skipRestart);

        if (skipRestart) {
          console.log(`[billing] Queued resize for workspace ${workspace.id.substring(0, 8)} to ${targetTierName} (will apply on next restart)`);
          result.deferred.push({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            agentCount,
          });
        } else {
          console.log(`[billing] Resized workspace ${workspace.id.substring(0, 8)} to ${targetTierName}`);
          result.resized++;
        }
      } catch (error) {
        console.error(`[billing] Failed to resize workspace ${workspace.id}:`, error);
        result.failed++;
        // Continue with other workspaces even if one fails
      }
    }
  } catch (error) {
    console.error('[billing] Failed to resize workspaces:', error);
  }

  return result;
}

/**
 * GET /api/billing/plans
 * Get all available billing plans
 */
billingRouter.get('/plans', (req, res) => {
  const rawPlans = getAllPlans();

  // Transform plans to frontend format
  const plans = rawPlans.map((plan) => ({
    tier: plan.id,
    name: plan.name,
    description: plan.description,
    price: {
      monthly: plan.priceMonthly / 100, // Convert cents to dollars
      yearly: plan.priceYearly / 100,
    },
    features: plan.features,
    limits: plan.limits,
    recommended: plan.id === 'pro',
  }));

  // Add publishable key for frontend
  const config = getConfig();

  res.json({
    plans,
    publishableKey: config.stripe.publishableKey,
  });
});

/**
 * GET /api/billing/plans/:tier
 * Get a specific plan by tier
 */
billingRouter.get('/plans/:tier', (req, res) => {
  const { tier } = req.params;

  try {
    const plan = getPlan(tier as SubscriptionTier);
    res.json({ plan });
  } catch {
    res.status(404).json({ error: 'Plan not found' });
  }
});

/**
 * GET /api/billing/compare
 * Compare two plans
 */
billingRouter.get('/compare', (req, res) => {
  const { from, to } = req.query;

  if (!from || !to) {
    res.status(400).json({ error: 'Missing from or to parameter' });
    return;
  }

  try {
    const comparison = comparePlans(from as SubscriptionTier, to as SubscriptionTier);
    res.json({ comparison });
  } catch {
    res.status(400).json({ error: 'Invalid plan tier' });
  }
});

/**
 * GET /api/billing/subscription
 * Get current user's subscription status
 */
billingRouter.get('/subscription', requireAuth, async (req, res) => {
  const userId = req.session.userId!;

  try {
    // Fetch user from database
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Admin users have special status - show their current plan without Stripe
    if (isAdminUser(user.githubUsername)) {
      return res.json({
        tier: user.plan || 'enterprise',
        subscription: null,
        customer: null,
        isAdmin: true,
      });
    }

    // If user doesn't have a Stripe customer ID, use the database plan value
    // This handles manually-set plans and prevents hanging on Stripe API calls
    if (!user.stripeCustomerId) {
      return res.json({
        tier: user.plan || 'free',
        subscription: null,
        customer: null,
      });
    }

    const billing = getBillingService();

    // Get or create Stripe customer
    const customerId = user.stripeCustomerId ||
      await billing.getOrCreateCustomer(user.id, user.email || '', user.githubUsername);

    // Save customer ID to database if newly created
    if (!user.stripeCustomerId) {
      await db.users.update(userId, { stripeCustomerId: customerId });
    }

    // Get customer details
    const customer = await billing.getCustomer(customerId);

    if (!customer) {
      res.json({
        tier: 'free',
        subscription: null,
        customer: null,
      });
      return;
    }

    // Use Stripe subscription tier if active, otherwise fall back to database plan value
    // This allows manual plan overrides in the database to take effect
    const tier = customer.subscription?.tier || user.plan || 'free';

    res.json({
      tier,
      subscription: customer.subscription,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        paymentMethods: customer.paymentMethods,
        invoices: customer.invoices,
      },
    });
  } catch (error) {
    console.error('Failed to get subscription:', error);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

/**
 * POST /api/billing/checkout
 * Create a checkout session for subscription
 */
billingRouter.post('/checkout', requireAuth, async (req, res) => {
  const userId = req.session.userId!;
  const { tier, interval = 'month' } = req.body;

  if (!tier || !['pro', 'team', 'enterprise'].includes(tier)) {
    res.status(400).json({ error: 'Invalid tier' });
    return;
  }

  if (!['month', 'year'].includes(interval)) {
    res.status(400).json({ error: 'Invalid billing interval' });
    return;
  }

  const config = getConfig();

  try {
    // Fetch user from database
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Admin users get free upgrades - skip Stripe entirely
    if (isAdminUser(user.githubUsername)) {
      // Update user plan directly
      await db.users.update(userId, { plan: tier });
      console.log(`[billing] Admin user ${user.githubUsername} upgraded to ${tier} (free)`);

      // Resize workspaces to match new plan (wait for result to inform user)
      const resizeResult = await resizeWorkspacesForPlan(userId, tier as PlanType);

      // Build success URL with deferred workspace info if any
      let successUrl = `${config.appUrl}/billing/success?admin=true`;
      if (resizeResult.deferred.length > 0) {
        // Encode deferred workspaces info for the frontend to display
        const deferredInfo = encodeURIComponent(JSON.stringify(resizeResult.deferred));
        successUrl += `&deferred=${deferredInfo}`;
      }

      // Return a fake session that redirects to success
      return res.json({
        sessionId: 'admin-upgrade',
        checkoutUrl: successUrl,
        resizeResult, // Also include in response for API consumers
      });
    }

    const billing = getBillingService();

    // Get or create customer
    const customerId = user.stripeCustomerId ||
      await billing.getOrCreateCustomer(user.id, user.email || '', user.githubUsername);

    // Save customer ID to database
    if (!user.stripeCustomerId) {
      await db.users.update(userId, { stripeCustomerId: customerId });
    }

    // Create checkout session
    const session = await billing.createCheckoutSession(
      customerId,
      tier as SubscriptionTier,
      interval as 'month' | 'year',
      `${config.appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      `${config.appUrl}/billing/canceled`
    );

    res.json(session);
  } catch (error) {
    console.error('Failed to create checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/billing/portal
 * Create a billing portal session for managing subscription
 */
billingRouter.post('/portal', requireAuth, async (req, res) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeCustomerId) {
      res.status(400).json({ error: 'No billing account found' });
      return;
    }

    const billing = getBillingService();
    const config = getConfig();

    const session = await billing.createPortalSession(
      user.stripeCustomerId,
      `${config.appUrl}/billing`
    );

    res.json(session);
  } catch (error) {
    console.error('Failed to create portal session:', error);
    res.status(500).json({ error: 'Failed to create billing portal' });
  }
});

/**
 * POST /api/billing/change
 * Change subscription tier
 */
billingRouter.post('/change', requireAuth, async (req, res) => {
  const userId = req.session.userId!;
  const { tier, interval = 'month' } = req.body;

  if (!tier || !['free', 'pro', 'team', 'enterprise'].includes(tier)) {
    res.status(400).json({ error: 'Invalid tier' });
    return;
  }

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeCustomerId) {
      res.status(400).json({ error: 'No billing account found' });
      return;
    }

    const billing = getBillingService();

    // Get current subscription
    const customer = await billing.getCustomer(user.stripeCustomerId);

    if (!customer?.subscription) {
      res.status(400).json({ error: 'No active subscription' });
      return;
    }

    // Handle downgrade to free (cancel)
    if (tier === 'free') {
      const subscription = await billing.cancelSubscription(
        customer.subscription.stripeSubscriptionId
      );
      res.json({ subscription, message: 'Subscription will be canceled at period end' });
      return;
    }

    // Change subscription
    const subscription = await billing.changeSubscription(
      customer.subscription.stripeSubscriptionId,
      tier as SubscriptionTier,
      interval as 'month' | 'year'
    );

    res.json({ subscription });
  } catch (error) {
    console.error('Failed to change subscription:', error);
    res.status(500).json({ error: 'Failed to change subscription' });
  }
});

/**
 * POST /api/billing/cancel
 * Cancel subscription at period end
 */
billingRouter.post('/cancel', requireAuth, async (req, res) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeCustomerId) {
      res.status(400).json({ error: 'No billing account found' });
      return;
    }

    const billing = getBillingService();
    const customer = await billing.getCustomer(user.stripeCustomerId);

    if (!customer?.subscription) {
      res.status(400).json({ error: 'No active subscription' });
      return;
    }

    const subscription = await billing.cancelSubscription(
      customer.subscription.stripeSubscriptionId
    );

    res.json({
      subscription,
      message: `Subscription will be canceled on ${subscription.currentPeriodEnd.toLocaleDateString()}`,
    });
  } catch (error) {
    console.error('Failed to cancel subscription:', error);
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

/**
 * POST /api/billing/resume
 * Resume a canceled subscription
 */
billingRouter.post('/resume', requireAuth, async (req, res) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeCustomerId) {
      res.status(400).json({ error: 'No billing account found' });
      return;
    }

    const billing = getBillingService();
    const customer = await billing.getCustomer(user.stripeCustomerId);

    if (!customer?.subscription) {
      res.status(400).json({ error: 'No subscription to resume' });
      return;
    }

    if (!customer.subscription.cancelAtPeriodEnd) {
      res.status(400).json({ error: 'Subscription is not set to cancel' });
      return;
    }

    const subscription = await billing.resumeSubscription(
      customer.subscription.stripeSubscriptionId
    );

    res.json({ subscription, message: 'Subscription resumed' });
  } catch (error) {
    console.error('Failed to resume subscription:', error);
    res.status(500).json({ error: 'Failed to resume subscription' });
  }
});

/**
 * GET /api/billing/invoices
 * Get user's invoices
 */
billingRouter.get('/invoices', requireAuth, async (req, res) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // No Stripe customer = no invoices, skip Stripe call entirely
    if (!user.stripeCustomerId) {
      return res.json({ invoices: [] });
    }

    const billing = getBillingService();
    const customer = await billing.getCustomer(user.stripeCustomerId);
    res.json({ invoices: customer?.invoices || [] });
  } catch (error) {
    console.error('Failed to get invoices:', error);
    res.status(500).json({ error: 'Failed to get invoices' });
  }
});

/**
 * GET /api/billing/upcoming
 * Get upcoming invoice preview
 */
billingRouter.get('/upcoming', requireAuth, async (req, res) => {
  const userId = req.session.userId!;

  try {
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.stripeCustomerId) {
      res.json({ invoice: null });
      return;
    }

    const billing = getBillingService();
    const invoice = await billing.getUpcomingInvoice(user.stripeCustomerId);
    res.json({ invoice });
  } catch (error) {
    console.error('Failed to get upcoming invoice:', error);
    res.status(500).json({ error: 'Failed to get upcoming invoice' });
  }
});

/**
 * POST /api/billing/webhook
 * Handle Stripe webhooks
 */
billingRouter.post(
  '/webhook',
  // Use raw body for webhook signature verification
  (req, res, next) => {
    if (req.headers['content-type'] === 'application/json') {
      next();
    } else {
      next();
    }
  },
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!sig) {
      res.status(400).json({ error: 'Missing signature' });
      return;
    }

    const billing = getBillingService();

    try {
      // Use the preserved raw body from express.json verify callback
      // This is critical for Stripe signature verification - JSON.stringify(req.body) won't work
      const rawBody = (req as Request & { rawBody?: string }).rawBody;

      if (!rawBody) {
        console.error('Raw body not available for Stripe webhook verification');
        res.status(400).json({ error: 'Raw body not available' });
        return;
      }

      // Verify and parse event
      const event = billing.verifyWebhookSignature(rawBody, sig as string);

      // Process the event
      const billingEvent = await billing.processWebhookEvent(event);

      // Log for debugging
      console.log('Processed billing event:', {
        id: billingEvent.id,
        type: billingEvent.type,
        userId: billingEvent.userId,
      });

      // Handle specific events
      switch (billingEvent.type) {
        case 'subscription.created':
        case 'subscription.updated': {
          // Extract subscription tier and update user's plan
          if (billingEvent.userId) {
            const subscription = billingEvent.data as unknown as Stripe.Subscription;
            const tier = billing.getTierFromSubscription(subscription) as PlanType;

            // Update user's plan in database
            await db.users.update(billingEvent.userId, { plan: tier });
            console.log(`Updated user ${billingEvent.userId} plan to: ${tier}`);

            // Resize workspaces to match new plan (async, don't block webhook)
            resizeWorkspacesForPlan(billingEvent.userId, tier).then((result) => {
              if (result.deferred.length > 0) {
                console.log(`[billing] User ${billingEvent.userId} upgrade: ${result.resized} resized, ${result.deferred.length} deferred (have active agents)`);
                result.deferred.forEach((d) => {
                  console.log(`[billing]   - "${d.workspaceName}" has ${d.agentCount} agent(s), will resize on next restart`);
                });
              } else {
                console.log(`[billing] User ${billingEvent.userId} upgrade: all ${result.resized} workspace(s) resized immediately`);
              }
            }).catch((err) => {
              console.error(`Failed to resize workspaces for user ${billingEvent.userId}:`, err);
            });
          } else {
            console.warn('Subscription event received without userId:', billingEvent.id);
          }
          break;
        }

        case 'subscription.canceled': {
          // Reset user to free plan
          if (billingEvent.userId) {
            await db.users.update(billingEvent.userId, { plan: 'free' });
            console.log(`User ${billingEvent.userId} subscription canceled, reset to free plan`);

            // Resize workspaces down to free tier (async)
            resizeWorkspacesForPlan(billingEvent.userId, 'free').catch((err) => {
              console.error(`Failed to resize workspaces for user ${billingEvent.userId}:`, err);
            });
          }
          break;
        }

        case 'invoice.payment_failed':
          // Log payment failure (don't immediately downgrade - Stripe retries)
          console.log('Payment failed for user:', billingEvent.userId);
          break;
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).json({ error: 'Webhook verification failed' });
    }
  }
);
