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
    });
  },
});
