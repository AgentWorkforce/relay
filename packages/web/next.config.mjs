import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/*': ['../../docs/**/*.mdx', '../openclaw/skill/SKILL.md'],
  },
};

export default nextConfig;
