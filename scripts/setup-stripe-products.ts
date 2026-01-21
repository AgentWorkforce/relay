#!/usr/bin/env npx tsx
/**
 * Setup Stripe Products and Prices
 *
 * Creates products and prices in Stripe for all billing plans.
 * Run this when:
 * - Setting up a new Stripe account
 * - Migrating to a new Stripe org
 * - Updating pricing (creates new prices, keeps old ones for existing subscriptions)
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_xxx npx tsx scripts/setup-stripe-products.ts
 *
 * Options:
 *   --dry-run    Show what would be created without making changes
 *   --update     Update existing products (name, description, metadata)
 */

import Stripe from 'stripe';

// Plan definitions (mirrors src/cloud/billing/plans.ts)
const PLANS = [
  {
    id: 'pro',
    name: 'Pro',
    description: 'For professional developers building with AI agents',
    priceMonthly: 6900, // $69/month
    priceYearly: 69000, // $690/year (2 months free)
    features: [
      'Up to 5 workspaces',
      'Up to 5 agents per workspace',
      '50 compute hours/month',
      '10 GB storage',
      '3 team members',
      'Custom domains',
      'Session persistence',
      'Email support',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    description: 'For growing teams with advanced needs',
    priceMonthly: 12900, // $129/month
    priceYearly: 129000, // $1290/year (2 months free)
    features: [
      'Up to 50 workspaces',
      'Up to 25 agents per workspace',
      '500 compute hours/month',
      '50 GB storage',
      '25 team members',
      'Custom domains',
      'Session persistence',
      'Priority support',
      'Audit logs',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'For organizations requiring dedicated support and SLAs',
    priceMonthly: 49900, // $499/month
    priceYearly: 499000, // $4990/year
    features: [
      'Unlimited workspaces',
      'Unlimited agents',
      'Unlimited compute hours',
      '500 GB storage',
      'Unlimited team members',
      'Custom domains',
      'Session persistence',
      'Priority support with SLA',
      'SSO/SAML integration',
      'Audit logs & compliance',
      'Dedicated account manager',
    ],
  },
];

interface CreatedResources {
  products: Map<string, string>; // plan id -> product id
  prices: Map<string, { monthly: string; yearly: string }>; // plan id -> price ids
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const update = args.includes('--update');

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('Error: STRIPE_SECRET_KEY environment variable is required');
    console.error('Usage: STRIPE_SECRET_KEY=sk_test_xxx npx tsx scripts/setup-stripe-products.ts');
    process.exit(1);
  }

  const isTestMode = stripeKey.startsWith('sk_test_');
  console.log(`\n🔑 Using Stripe ${isTestMode ? 'TEST' : 'LIVE'} mode\n`);

  if (!isTestMode && !dryRun) {
    console.warn('⚠️  WARNING: You are about to create products in LIVE mode!');
    console.warn('   Run with --dry-run first to preview changes.\n');
    // Give user a chance to cancel
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  if (dryRun) {
    console.log('🔍 DRY RUN - No changes will be made\n');
  }

  const stripe = new Stripe(stripeKey);
  const created: CreatedResources = {
    products: new Map(),
    prices: new Map(),
  };

  // Check for existing products
  console.log('📦 Checking for existing products...\n');
  const existingProducts = await stripe.products.list({ limit: 100, active: true });
  const productsByPlanId = new Map<string, Stripe.Product>();

  for (const product of existingProducts.data) {
    const planId = product.metadata?.plan_id;
    if (planId && PLANS.some((p) => p.id === planId)) {
      productsByPlanId.set(planId, product);
      console.log(`  Found existing product for ${planId}: ${product.id}`);
    }
  }

  // Create or update products
  console.log('\n📦 Creating/updating products...\n');

  for (const plan of PLANS) {
    const existingProduct = productsByPlanId.get(plan.id);

    if (existingProduct) {
      if (update) {
        console.log(`  Updating product: ${plan.name} (${existingProduct.id})`);
        if (!dryRun) {
          await stripe.products.update(existingProduct.id, {
            name: `Agent Relay ${plan.name}`,
            description: plan.description,
            metadata: {
              plan_id: plan.id,
              features: plan.features.join('|'),
            },
          });
        }
      } else {
        console.log(`  Skipping existing product: ${plan.name} (${existingProduct.id})`);
      }
      created.products.set(plan.id, existingProduct.id);
    } else {
      console.log(`  Creating product: ${plan.name}`);
      if (!dryRun) {
        const product = await stripe.products.create({
          name: `Agent Relay ${plan.name}`,
          description: plan.description,
          metadata: {
            plan_id: plan.id,
            features: plan.features.join('|'),
          },
        });
        created.products.set(plan.id, product.id);
        console.log(`    Created: ${product.id}`);
      } else {
        created.products.set(plan.id, `prod_${plan.id}_placeholder`);
      }
    }
  }

  // Check for existing prices
  console.log('\n💰 Checking for existing prices...\n');
  const existingPrices = await stripe.prices.list({ limit: 100, active: true });
  const pricesByPlanId = new Map<string, { monthly?: Stripe.Price; yearly?: Stripe.Price }>();

  for (const price of existingPrices.data) {
    const planId = price.metadata?.plan_id;
    const interval = price.recurring?.interval;
    if (planId && PLANS.some((p) => p.id === planId)) {
      if (!pricesByPlanId.has(planId)) {
        pricesByPlanId.set(planId, {});
      }
      const existing = pricesByPlanId.get(planId)!;
      if (interval === 'month') {
        existing.monthly = price;
        console.log(`  Found existing monthly price for ${planId}: ${price.id} ($${price.unit_amount! / 100})`);
      } else if (interval === 'year') {
        existing.yearly = price;
        console.log(`  Found existing yearly price for ${planId}: ${price.id} ($${price.unit_amount! / 100})`);
      }
    }
  }

  // Create prices
  console.log('\n💰 Creating prices...\n');

  for (const plan of PLANS) {
    const productId = created.products.get(plan.id);
    if (!productId) {
      console.error(`  Error: No product ID for ${plan.id}`);
      continue;
    }

    const existingPlanPrices = pricesByPlanId.get(plan.id) || {};
    const planPrices: { monthly: string; yearly: string } = { monthly: '', yearly: '' };

    // Monthly price
    if (existingPlanPrices.monthly && existingPlanPrices.monthly.unit_amount === plan.priceMonthly) {
      console.log(`  Skipping existing monthly price for ${plan.name}: $${plan.priceMonthly / 100}/mo`);
      planPrices.monthly = existingPlanPrices.monthly.id;
    } else {
      if (existingPlanPrices.monthly) {
        console.log(`  Price changed for ${plan.name} monthly: $${existingPlanPrices.monthly.unit_amount! / 100} -> $${plan.priceMonthly / 100}`);
      }
      console.log(`  Creating monthly price for ${plan.name}: $${plan.priceMonthly / 100}/mo`);
      if (!dryRun) {
        const price = await stripe.prices.create({
          product: productId,
          unit_amount: plan.priceMonthly,
          currency: 'usd',
          recurring: { interval: 'month' },
          metadata: {
            plan_id: plan.id,
            interval: 'month',
          },
        });
        planPrices.monthly = price.id;
        console.log(`    Created: ${price.id}`);

        // Archive old price if it exists
        if (existingPlanPrices.monthly) {
          console.log(`    Archiving old price: ${existingPlanPrices.monthly.id}`);
          await stripe.prices.update(existingPlanPrices.monthly.id, { active: false });
        }
      } else {
        planPrices.monthly = `price_${plan.id}_monthly_placeholder`;
      }
    }

    // Yearly price
    if (existingPlanPrices.yearly && existingPlanPrices.yearly.unit_amount === plan.priceYearly) {
      console.log(`  Skipping existing yearly price for ${plan.name}: $${plan.priceYearly / 100}/yr`);
      planPrices.yearly = existingPlanPrices.yearly.id;
    } else {
      if (existingPlanPrices.yearly) {
        console.log(`  Price changed for ${plan.name} yearly: $${existingPlanPrices.yearly.unit_amount! / 100} -> $${plan.priceYearly / 100}`);
      }
      console.log(`  Creating yearly price for ${plan.name}: $${plan.priceYearly / 100}/yr`);
      if (!dryRun) {
        const price = await stripe.prices.create({
          product: productId,
          unit_amount: plan.priceYearly,
          currency: 'usd',
          recurring: { interval: 'year' },
          metadata: {
            plan_id: plan.id,
            interval: 'year',
          },
        });
        planPrices.yearly = price.id;
        console.log(`    Created: ${price.id}`);

        // Archive old price if it exists
        if (existingPlanPrices.yearly) {
          console.log(`    Archiving old price: ${existingPlanPrices.yearly.id}`);
          await stripe.prices.update(existingPlanPrices.yearly.id, { active: false });
        }
      } else {
        planPrices.yearly = `price_${plan.id}_yearly_placeholder`;
      }
    }

    created.prices.set(plan.id, planPrices);
  }

  // Output environment variables
  console.log('\n' + '='.repeat(60));
  console.log('📋 Environment Variables to Set:');
  console.log('='.repeat(60) + '\n');

  const envVars: string[] = [];

  for (const plan of PLANS) {
    const prices = created.prices.get(plan.id);
    if (prices) {
      const monthlyVar = `STRIPE_${plan.id.toUpperCase()}_MONTHLY_PRICE_ID=${prices.monthly}`;
      const yearlyVar = `STRIPE_${plan.id.toUpperCase()}_YEARLY_PRICE_ID=${prices.yearly}`;
      envVars.push(monthlyVar, yearlyVar);
      console.log(monthlyVar);
      console.log(yearlyVar);
      console.log();
    }
  }

  // Output .env format
  console.log('='.repeat(60));
  console.log('📄 Copy to .env file:');
  console.log('='.repeat(60) + '\n');
  console.log(envVars.join('\n'));

  console.log('\n✅ Done!\n');

  if (dryRun) {
    console.log('This was a dry run. Run without --dry-run to create resources.\n');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
