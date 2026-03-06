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
      domain: $app.stage === 'production'
        ? {
            name: 'agentrelay.net',
            dns: sst.cloudflare.dns({ proxy: true }),
          }
        : undefined,
    });
  },
});
