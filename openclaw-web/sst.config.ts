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
  async run() {
    const router = new sst.aws.Router(
      'OpenClawRouter',
      isProductionStage
        ? {
            domain: {
              name: 'agentrelay.net',
              dns: sst.cloudflare.dns({ proxy: true }),
            },
          }
        : {}
    );

    new sst.aws.Nextjs('OpenClawWeb', {
      path: '.',
      router: {
        instance: router,
        path: '/',
      },
    });
  },
});
