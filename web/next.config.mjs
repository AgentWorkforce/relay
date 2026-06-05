import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  outputFileTracingIncludes: {
    '/*': ['content/docs/**/*', 'content/blog/**/*'],
    // The Pear OG card embeds these at render time.
    '/pear/og.png': ['public/img/pear-app.png', 'public/brand-kit/pear-icon-transparent.png'],
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.md$/,
      resourceQuery: /raw/,
      type: 'asset/source',
    });

    return config;
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
    ];
  },
};

export default nextConfig;
