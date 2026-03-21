export default $config({
  app(input) {
    return {
      name: 'relay-web',
      home: 'aws',
      removal: 'remove',
    };
  },
  run() {
    const waitlist = new sst.aws.Dynamo('Waitlist', {
      fields: {
        email: 'string',
      },
      primaryIndex: { hashKey: 'email' },
    });

    new sst.aws.Nextjs('Web', {
      path: '.',
      openNextVersion: '3.6.2',
      link: [waitlist],
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
