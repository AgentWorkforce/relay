let isProductionStage = false;

export default $config({
  app(input) {
    isProductionStage = input.stage === 'production';
    return {
      name: 'relay-openclaw-page',
      home: 'aws',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
    };
  },
  run() {
    new sst.aws.Nextjs('OpenClawWeb', {
      path: '.',
      domain: isProductionStage
        ? {
            name: 'agentrelay.net',
            dns: sst.cloudflare.dns({ proxy: true }),
          }
        : undefined,
    });
  },
});
