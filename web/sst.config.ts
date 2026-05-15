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
    const domain = isProd ? 'orgin.agentrelay.net' : `${$app.stage}.agentrelay.net`;
    const NEXT_PUBLIC_POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://i.agentrelay.com';
    const NEXT_PUBLIC_POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '';

    // Non-prod stages reuse a shared CloudFront cache policy + KV store so the
    // per-account quotas (20 cache policies / 5 KV stores) don't cap how many
    // preview deploys can exist concurrently. The IDs are written to SSM by
    // web/scripts/bootstrap-preview-infra.sh; SST namespaces KV keys by stage
    // so a shared store is safe.
    const previewCachePolicyId = isProd
      ? undefined
      : aws.ssm.getParameterOutput({ name: '/relay-web/preview/cache-policy-id' }).value;
    const previewKvStoreArn = isProd
      ? undefined
      : aws.ssm.getParameterOutput({ name: '/relay-web/preview/kv-store-arn' }).value;

    new sst.aws.Nextjs('Web', {
      path: '.',
      openNextVersion: '3.9.16',
      environment: {
        NEXT_PUBLIC_POSTHOG_HOST,
        NEXT_PUBLIC_POSTHOG_KEY,
      },
      // Production deploys land on orgin.agentrelay.net; SEO canonicals are set in Next metadata.
      domain: { name: domain, dns: sst.cloudflare.dns({ proxy: true }) },
      ...(previewCachePolicyId ? { cachePolicy: previewCachePolicyId } : {}),
      ...(previewKvStoreArn
        ? { edge: { viewerRequest: { kvStore: previewKvStoreArn, injection: '' } } }
        : {}),
    });
  },
});
