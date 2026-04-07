export default $config({
  app(input) {
    return {
      name: 'relay-web',
      home: 'aws',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
    };
  },
  run() {
    const waitlist = new sst.aws.Dynamo('Waitlist', {
      fields: {
        email: 'string',
      },
      primaryIndex: { hashKey: 'email' },
    });

    const isProd = $app.stage === 'production';
    const domain = isProd ? 'agentrelay.net' : `${$app.stage}.agentrelay.net`;
    const NEXT_PUBLIC_POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://i.agentrelay.com';
    const NEXT_PUBLIC_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';

    new sst.aws.Nextjs('Web', {
      path: '.',
      openNextVersion: '3.9.16',
      environment: {
        NEXT_PUBLIC_POSTHOG_HOST,
        NEXT_PUBLIC_POSTHOG_KEY,
      },
      link: [waitlist],
      // Production is proxied by agentrelay.com; SEO canonicals are set in Next metadata.
      domain: { name: domain, dns: sst.cloudflare.dns({ proxy: true }) },
    });
  },
});
