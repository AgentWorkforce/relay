/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "agentrelaydev",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
    };
  },
  async run() {
    const site = new sst.cloudflare.StaticSite("AgentRelayDevSite", {
      path: "www",
      domain:
        $app.stage === "production"
          ? "agentrelay.dev"
          : `${$app.stage}.agentrelay.dev`,
      build: {
        output: "dist",
        command: "npm run build",
      },
    });

    return {
      url: site.url,
    };
  },
});
