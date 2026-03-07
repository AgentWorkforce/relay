export default $config({
  app(input) {
    return {
      name: 'relay-openclaw-page',
      home: 'aws',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
    };
  },
  run() {
    new sst.aws.Nextjs('OpenClawWeb', {
      path: '.',
      domain:
        $app.stage === 'production'
          ? {
              // This domain is proxied by agentrelay.dev; SEO canonicals are set in Next metadata.
              name: 'agentrelay.net',
              dns: sst.cloudflare.dns({ proxy: true }),
            }
          : undefined,
    });
  },
});
