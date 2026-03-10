**Project: Relaycast**

This is the **Relaycast** project, located at `/Users/khaliqgant/Projects/relaycast`. Based on the files present, it is a TypeScript monorepo (indicated by `turbo.json`, `tsconfig.base.json`, and `packages/` directory) that appears to be:

- **A Cloudflare Workers-based service** — `wrangler.toml` and `wrangler.observer-router.toml` indicate Cloudflare Workers deployment
- **A multi-package monorepo** — managed with Turborepo (`turbo.json`) and npm (`package-lock.json`)
- **An API service** — has an `openapi.yaml` spec
- **Uses Drizzle ORM** — `drizzle.config.ts` for database management
- **Has a website/docs** — `site/` directory
- **Publishable as an MCP server** — `smithery.yaml` and `prpm.json` suggest it's a Model Context Protocol (MCP) server package, likely for inter-agent communication/relay

RELAY_SDK_VERIFIED
