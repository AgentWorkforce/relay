import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  outputFileTracingIncludes: {
    '/*': ['../packages/openclaw/skill/SKILL.md'],
  },
  async rewrites() {
    return [
      { source: '/relayfile', destination: '/file' },
      { source: '/relayfile/:path*', destination: '/file/:path*' },
      { source: '/relayauth', destination: '/auth' },
      { source: '/relayauth/:path*', destination: '/auth/:path*' },
      { source: '/relaycast', destination: '/message' },
      { source: '/relaycast/:path*', destination: '/message/:path*' },
    ];
  },
};

export default nextConfig;
