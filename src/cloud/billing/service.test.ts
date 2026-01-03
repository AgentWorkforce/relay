import { describe, it, expect, beforeEach, vi } from 'vitest';

let mockStripe: ReturnType<typeof createStripeMock>;
const stripeConstructor = vi.fn();

const basePriceIds = {
  proMonthly: 'price_pro_monthly',
  proYearly: 'price_pro_yearly',
  teamMonthly: 'price_team_monthly',
  teamYearly: 'price_team_yearly',
  enterpriseMonthly: 'price_enterprise_monthly',
  enterpriseYearly: 'price_enterprise_yearly',
};

const mockConfig = {
  stripe: {
    secretKey: 'sk_test',
    publishableKey: 'pk_test',
    webhookSecret: 'whsec_test',
    priceIds: { ...basePriceIds },
  },
} as any;

class StripeError extends Error {
  code?: string;

  constructor(message?: string, code?: string) {
    super(message);
    this.code = code;
  }
}

function createStripeMock() {
  return {
    customers: {
      search: vi.fn(),
      create: vi.fn(),
      retrieve: vi.fn(),
      update: vi.fn(),
    },
    paymentMethods: {
      list: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
    },
    invoices: {
      list: vi.fn(),
      retrieveUpcoming: vi.fn(),
    },
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(),
      },
    },
    subscriptions: {
      retrieve: vi.fn(),
      update: vi.fn(),
    },
    subscriptionItems: {
      createUsageRecord: vi.fn(),
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  };
}

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock('stripe', () => ({
  default: vi.fn((key: string) => {
    stripeConstructor(key);
    return mockStripe;
  }),
  errors: { StripeError },
}));

const createService = async () => {
  const { BillingService } = await import('./service.js');
  return new BillingService();
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockStripe = createStripeMock();
  mockConfig.stripe.priceIds = { ...basePriceIds };
});

describe('BillingService customers', () => {
  it('returns existing customer when found', async () => {
    mockStripe.customers.search.mockResolvedValue({ data: [{ id: 'cus_123' }] });

    const service = await createService();
    const id = await service.getOrCreateCustomer('user-1', 'user@example.com', 'User');

    expect(id).toBe('cus_123');
    expect(mockStripe.customers.search).toHaveBeenCalledWith({
      query: "metadata['user_id']:'user-1'",
      limit: 1,
    });
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
  });

  it('creates a customer when none exists', async () => {
    mockStripe.customers.search.mockResolvedValue({ data: [] });
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_new' });

    const service = await createService();
    const id = await service.getOrCreateCustomer('user-1', 'user@example.com', 'User');

    expect(id).toBe('cus_new');
    expect(mockStripe.customers.create).toHaveBeenCalledWith({
      email: 'user@example.com',
      name: 'User',
      metadata: { user_id: 'user-1' },
    });
  });

  it('returns mapped customer data', async () => {
    const subscription = {
      id: 'sub_123',
      status: 'active',
      metadata: { tier: 'pro' },
      items: { data: [{ id: 'si_123', price: { id: 'price_pro_monthly', recurring: { interval: 'month' } } }] },
      current_period_start: 1,
      current_period_end: 2,
      cancel_at_period_end: false,
      created: 3,
    } as any;
    const paymentMethod = {
      id: 'pm_1',
      type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    } as any;
    const invoice = {
      id: 'inv_1',
      amount_due: 500,
      amount_paid: 500,
      status: 'paid',
      invoice_pdf: 'pdf',
      hosted_invoice_url: 'url',
      period_start: 10,
      period_end: 20,
      created: 30,
    } as any;
    mockStripe.customers.retrieve.mockResolvedValue({
      id: 'cus_123',
      email: 'user@example.com',
      name: 'User',
      metadata: { user_id: 'user-1' },
      subscriptions: { data: [subscription] },
      created: 0,
    });
    mockStripe.paymentMethods.list.mockResolvedValue({ data: [paymentMethod] });
    mockStripe.invoices.list.mockResolvedValue({ data: [invoice] });

    const service = await createService();
    const result = await service.getCustomer('cus_123');

    expect(result?.id).toBe('user-1');
    expect(result?.stripeCustomerId).toBe('cus_123');
    expect(result?.subscription?.id).toBe('sub_123');
    expect(result?.subscription?.tier).toBe('pro');
    expect(result?.paymentMethods[0]).toEqual({
      id: 'pm_1',
      stripePaymentMethodId: 'pm_1',
      type: 'card',
      isDefault: false,
      card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
    });
    expect(result?.invoices[0].id).toBe('inv_1');
  });

  it('returns null when customer is deleted or missing', async () => {
    mockStripe.customers.retrieve.mockResolvedValueOnce({ deleted: true });

    const service = await createService();
    expect(await service.getCustomer('cus_deleted')).toBeNull();
    expect(mockStripe.paymentMethods.list).not.toHaveBeenCalled();

    mockStripe.customers.retrieve.mockRejectedValueOnce({ code: 'resource_missing' });
    expect(await service.getCustomer('cus_missing')).toBeNull();
  });
});

describe('BillingService checkout and portal sessions', () => {
  it('creates checkout session for a tier and interval', async () => {
    mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'sess_1', url: 'https://checkout' });

    const service = await createService();
    const session = await service.createCheckoutSession(
      'cus_123',
      'pro',
      'month',
      'https://success',
      'https://cancel'
    );

    expect(session).toEqual({ sessionId: 'sess_1', url: 'https://checkout' });
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_123',
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: 'price_pro_monthly', quantity: 1 }],
      success_url: 'https://success',
      cancel_url: 'https://cancel',
      subscription_data: { metadata: { tier: 'pro' } },
      allow_promotion_codes: true,
    });
  });

  it('throws when price ID is not configured', async () => {
    mockConfig.stripe.priceIds.proMonthly = undefined;
    const service = await createService();

    await expect(() =>
      service.createCheckoutSession('cus_123', 'pro', 'month', 'ok', 'cancel')
    ).rejects.toThrow('No price configured for pro monthly plan');
  });

  it('creates billing portal session', async () => {
    mockStripe.billingPortal.sessions.create.mockResolvedValue({ url: 'https://portal' });
    const service = await createService();

    const session = await service.createPortalSession('cus_123', 'https://return');

    expect(session).toEqual({ url: 'https://portal' });
    expect(mockStripe.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'https://return',
    });
  });
});

describe('BillingService subscriptions', () => {
  it('changes subscription tier with proration', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      items: { data: [{ id: 'si_123' }] },
    });
    mockStripe.subscriptions.update.mockResolvedValue({
      id: 'sub_123',
      status: 'active',
      metadata: { tier: 'team' },
      items: { data: [{ price: { id: 'price_team_yearly', recurring: { interval: 'year' } } }] },
      current_period_start: 10,
      current_period_end: 20,
      cancel_at_period_end: false,
      created: 0,
    });
    const service = await createService();

    const result = await service.changeSubscription('sub_123', 'team', 'year');

    expect(result.tier).toBe('team');
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      items: [{ id: 'si_123', price: 'price_team_yearly' }],
      metadata: { tier: 'team' },
      proration_behavior: 'create_prorations',
    });
  });

  it('cancels and resumes subscriptions', async () => {
    mockStripe.subscriptions.update
      .mockResolvedValueOnce({
        id: 'sub_123',
        status: 'active',
        metadata: {},
        items: { data: [{ price: { id: 'price_pro_monthly', recurring: { interval: 'month' } } }] },
        current_period_start: 1,
        current_period_end: 2,
        cancel_at_period_end: true,
        created: 0,
      })
      .mockResolvedValueOnce({
        id: 'sub_123',
        status: 'active',
        metadata: {},
        items: { data: [{ price: { id: 'price_pro_monthly', recurring: { interval: 'month' } } }] },
        current_period_start: 1,
        current_period_end: 2,
        cancel_at_period_end: false,
        created: 0,
      });

    const service = await createService();

    const canceled = await service.cancelSubscription('sub_123');
    expect(canceled.cancelAtPeriodEnd).toBe(true);

    const resumed = await service.resumeSubscription('sub_123');
    expect(resumed.cancelAtPeriodEnd).toBe(false);
    expect(mockStripe.subscriptions.update).toHaveBeenCalledTimes(2);
  });
});

describe('BillingService payment methods', () => {
  it('adds payment method and sets default when requested', async () => {
    const paymentMethod = {
      id: 'pm_1',
      type: 'card',
      card: { brand: 'visa', last4: '4242', exp_month: 11, exp_year: 2031 },
    } as any;
    mockStripe.paymentMethods.attach.mockResolvedValue(paymentMethod);
    const service = await createService();

    const result = await service.addPaymentMethod('cus_123', 'pm_1', true);

    expect(result.isDefault).toBe(true);
    expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_123', {
      invoice_settings: { default_payment_method: 'pm_1' },
    });
  });

  it('removes payment method', async () => {
    const service = await createService();

    await service.removePaymentMethod('pm_1');

    expect(mockStripe.paymentMethods.detach).toHaveBeenCalledWith('pm_1');
  });

  it('sets default payment method', async () => {
    const service = await createService();

    await service.setDefaultPaymentMethod('cus_123', 'pm_2');

    expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_123', {
      invoice_settings: { default_payment_method: 'pm_2' },
    });
  });
});

describe('BillingService invoices and usage', () => {
  it('returns upcoming invoice when present', async () => {
    const invoice = {
      id: null,
      amount_due: 1000,
      amount_paid: 0,
      status: 'draft',
      period_start: 1,
      period_end: 2,
      created: 3,
    } as any;
    mockStripe.invoices.retrieveUpcoming.mockResolvedValue(invoice);

    const service = await createService();
    const result = await service.getUpcomingInvoice('cus_123');

    expect(result?.id).toBe('upcoming');
    expect(result?.status).toBe('draft');
  });

  it('returns null when no upcoming invoice', async () => {
    mockStripe.invoices.retrieveUpcoming.mockRejectedValue(new StripeError('none', 'invoice_upcoming_none'));
    const service = await createService();

    const result = await service.getUpcomingInvoice('cus_123');

    expect(result).toBeNull();
  });

  it('records usage with timestamp conversion', async () => {
    const service = await createService();
    const timestamp = new Date(5_000);

    await service.recordUsage('si_123', 10, timestamp);

    expect(mockStripe.subscriptionItems.createUsageRecord).toHaveBeenCalledWith('si_123', {
      quantity: 10,
      timestamp: 5,
      action: 'increment',
    });
  });
});

describe('BillingService webhooks and events', () => {
  it('verifies webhook signature', async () => {
    const event = { id: 'evt_1' } as any;
    mockStripe.webhooks.constructEvent.mockReturnValue(event);
    const service = await createService();

    const result = service.verifyWebhookSignature('payload', 'sig');

    expect(result).toBe(event);
    expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith(
      'payload',
      'sig',
      'whsec_test'
    );
  });

  it('processes webhook event and resolves user id', async () => {
    mockStripe.customers.retrieve.mockResolvedValue({
      deleted: false,
      metadata: { user_id: 'user-1' },
    });
    const event: any = {
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: { object: { customer: 'cus_123' } },
      created: 10,
    };

    const service = await createService();
    const result = await service.processWebhookEvent(event);

    expect(result.userId).toBe('user-1');
    expect(result.type).toBe('subscription.updated');
    expect(result.processedAt).toBeInstanceOf(Date);
  });

  it('maps event types with fallback', async () => {
    const event: any = {
      id: 'evt_2',
      type: 'customer.unknown',
      data: { object: {} },
      created: 0,
    };
    const service = await createService();

    const result = await service.processWebhookEvent(event);

    expect(result.type).toBe('customer.updated');
  });
});

describe('BillingService tier helpers', () => {
  it('prefers metadata tier when present', async () => {
    const service = await createService();
    const tier = service.getTierFromSubscription({
      metadata: { tier: 'team' },
      items: { data: [{ price: { id: 'price_pro_monthly', recurring: { interval: 'month' } } }] },
    } as any);

    expect(tier).toBe('team');
  });

  it('falls back to price ID mapping', async () => {
    const service = await createService();
    const tier = service.getTierFromSubscription({
      metadata: {},
      items: { data: [{ price: { id: 'price_team_yearly', recurring: { interval: 'year' } } }] },
    } as any);

    expect(tier).toBe('team');
  });
});
