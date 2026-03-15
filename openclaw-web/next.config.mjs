import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/openclaw',
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  outputFileTracingIncludes: {
    '/*': ['../packages/openclaw/skill/SKILL.md'],
  },
  // Reduce cold-start by enabling module transpilation caching
  transpilePackages: [],
  experimental: {
    // Enable optimized package imports to reduce JS bundle parsed at startup
    optimizePackageImports: ['next/font'],
  },
};

export default nextConfig;
