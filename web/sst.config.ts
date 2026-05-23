const AWS_MANAGED_CACHING_DISABLED_CACHE_POLICY_ID = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

export default $config({
  app(input) {
    return {
      name: 'relay-web',
      home: 'aws',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
    };
  },
  async run() {
    const isProd = $app.stage === 'production';
    const isPreview = $app.stage.startsWith('pr-');
    const domain = isProd ? 'origin.agentrelay.net' : `${$app.stage}.agentrelay.net`;
    const NEXT_PUBLIC_POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://i.agentrelay.com';
    const NEXT_PUBLIC_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';

    const web = new sst.aws.Nextjs('Web', {
      path: '.',
      openNextVersion: '3.9.16',
      environment: {
        NEXT_PUBLIC_POSTHOG_HOST,
        NEXT_PUBLIC_POSTHOG_KEY,
      },
      // Production deploys land on origin.agentrelay.net; SEO canonicals are set in Next metadata.
      ...(isPreview ? {} : { domain: { name: domain, dns: sst.cloudflare.dns({ proxy: true }) } }),
      // PR previews use CloudFront's generated URL and should not allocate one custom cache policy per stage.
      ...(isPreview ? { cachePolicy: AWS_MANAGED_CACHING_DISABLED_CACHE_POLICY_ID } : {}),
    });

    return {
      url: web.url,
    };
  },
});
