export default $config({
  app(input) {
    return {
      name: 'relay-web',
      home: 'aws',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
    };
  },
  run() {
    const isProd = $app.stage === 'production';
    const AWS_MANAGED_CACHING_DISABLED_POLICY_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
    const domain = isProd ? 'orgin.agentrelay.net' : `${$app.stage}.agentrelay.net`;
    const NEXT_PUBLIC_POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://i.agentrelay.com';
    const NEXT_PUBLIC_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';

    new sst.aws.Nextjs('Web', {
      path: '.',
      openNextVersion: '3.9.16',
      environment: {
        NEXT_PUBLIC_POSTHOG_HOST,
        NEXT_PUBLIC_POSTHOG_KEY,
      },
      cachePolicy: isProd ? undefined : AWS_MANAGED_CACHING_DISABLED_POLICY_ID,
      // Production deploys land on orgin.agentrelay.net; SEO canonicals are set in Next metadata.
      domain: { name: domain, dns: sst.cloudflare.dns({ proxy: true }) },
    });
  },
});
