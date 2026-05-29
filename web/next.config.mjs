import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const legacyDocRedirects = [
  { source: '/docs/spawning-an-agent', destination: '/docs/runtime' },
  { source: '/docs/harness-runtime-config', destination: '/docs/harnesses' },
  { source: '/docs/sending-messages', destination: '/docs/messaging' },
  { source: '/docs/channels', destination: '/docs/messaging' },
  { source: '/docs/dms', destination: '/docs/messaging' },
  { source: '/docs/threads', destination: '/docs/messaging' },
  { source: '/docs/emoji-reactions', destination: '/docs/messaging' },
  { source: '/docs/cli-messaging', destination: '/docs/cli-overview' },
  { source: '/docs/cli-agent-management', destination: '/docs/runtime' },
  { source: '/docs/cli-broker-lifecycle', destination: '/docs/runtime' },
  { source: '/docs/cli-cloud-commands', destination: '/docs/migration' },
  { source: '/docs/cli-on-the-relay', destination: '/docs/agent-relay-mcp' },
  { source: '/docs/reference-cli', destination: '/docs/cli-overview' },
  { source: '/docs/reference-broker-api', destination: '/docs/runtime' },
  { source: '/docs/python-sdk', destination: '/docs/typescript-sdk' },
  { source: '/docs/react-sdk', destination: '/docs/typescript-sdk' },
  { source: '/docs/swift-sdk', destination: '/docs/typescript-sdk' },
  { source: '/docs/typescript-examples', destination: '/docs/quickstart' },
  { source: '/docs/cloud', destination: '/docs/workspaces' },
  { source: '/docs/workforce', destination: '/docs/migration' },
  { source: '/docs/proactive-agents', destination: '/docs/event-handlers' },
  { source: '/docs/file-sharing', destination: '/docs/messaging' },
  { source: '/docs/authentication', destination: '/docs/workspaces' },
  { source: '/docs/permissions', destination: '/docs/actions' },
  { source: '/docs/scheduling', destination: '/docs/event-handlers' },
  { source: '/docs/local-mode', destination: '/docs/workspaces' },
  { source: '/docs/observer', destination: '/docs/event-handlers' },
  { source: '/docs/relay-dashboard', destination: '/docs/event-handlers' },
  { source: '/docs/plugin-claude-code', destination: '/docs/harnesses' },
  { source: '/docs/communicate', destination: '/docs/messaging' },
  { source: '/docs/communicate-ai-sdk', destination: '/docs/messaging' },
  { source: '/docs/communicate-claude-sdk', destination: '/docs/messaging' },
  { source: '/docs/communicate-google-adk', destination: '/docs/messaging' },
  { source: '/docs/communicate-pi', destination: '/docs/messaging' },
  { source: '/docs/communicate-agno', destination: '/docs/messaging' },
  { source: '/docs/communicate-openai-agents', destination: '/docs/messaging' },
  { source: '/docs/communicate-swarms', destination: '/docs/messaging' },
  { source: '/docs/communicate-crewai', destination: '/docs/messaging' },
  { source: '/docs/doctor-orchestration-repros', destination: '/docs/migration' },
].map((redirect) => ({ ...redirect, permanent: false }));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  outputFileTracingIncludes: {
    '/*': ['content/docs/**/*', 'content/blog/**/*', '../packages/openclaw/skill/SKILL.md'],
  },
  async redirects() {
    return [
      { source: '/quickstart', destination: '/docs/quickstart', permanent: true },
      { source: '/relayfile', destination: '/primitives#file', permanent: true },
      { source: '/relayfile/:path*', destination: '/primitives#file', permanent: true },
      { source: '/relayauth', destination: '/primitives#auth', permanent: true },
      { source: '/relayauth/:path*', destination: '/primitives#auth', permanent: true },
      { source: '/relaycast', destination: '/primitives#message', permanent: true },
      { source: '/relaycast/:path*', destination: '/primitives#message', permanent: true },
      { source: '/docs/reference-sdk', destination: '/docs/typescript-sdk', permanent: true },
      { source: '/docs/reference-sdk-py', destination: '/docs/typescript-sdk', permanent: true },
      ...legacyDocRedirects,
    ];
  },
};

export default nextConfig;
