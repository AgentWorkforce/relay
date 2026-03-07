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
      openNextVersion: '3.6.2',
      domain:
        $app.stage === 'production'
          ? {
              // This domain is proxied by agentrelay.dev; SEO canonicals are set in Next metadata.
              name: 'agentrelay.net',
              dns: sst.cloudflare.dns({ proxy: true }),
            }
          : undefined,
      edge: {
        viewerRequest: {
          // Workaround: SST's routeSite uses the original URI (with basePath) when
          // routing to S3, but files are stored without the basePath prefix.
          // Patch setS3Origin to strip the basePath before the S3 request.
          injection: `
            var _origSetS3Origin = setS3Origin;
            setS3Origin = function(s3Domain, override) {
              event.request.uri = event.request.uri.replace("/openclaw", "");
              _origSetS3Origin(s3Domain, override);
            };
          `,
        },
      },
    });
  },
});
