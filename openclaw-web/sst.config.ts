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

    new sst.aws.StaticSite('OpenClawStaticPage', {
      path: '.',
      build: {
        command: 'node scripts/build-static.mjs',
        output: 'site',
      },
      router: {
        instance: router,
        path: '/openclaw',
      },
    });

    const openClawInviteFunctionArgs = {
      handler: 'src/openclaw.handler',
      nodejs: {
        loader: {
          '.md': 'text',
        },
      },
    };

    new sst.aws.Function('OpenClawInvitePage', {
      ...openClawInviteFunctionArgs,
      url: {
        router: {
          instance: router,
          path: '/openclaw/invite',
        },
      },
    });
  },
});
