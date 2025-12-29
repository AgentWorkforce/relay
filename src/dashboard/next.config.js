/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export - generates HTML/JS/CSS that can be served by any server
  output: 'export',
  distDir: 'out',

  // Disable strict mode for now during development
  reactStrictMode: true,

  // V2 is now the default dashboard at root path
  // Legacy v1 dashboard is available at /v1

  // Proxy API requests to the main dashboard server
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3888/api/:path*',
      },
      {
        source: '/ws',
        destination: 'http://localhost:3888/ws',
      },
    ];
  },

  // Webpack configuration for WebSocket support
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        net: false,
        tls: false,
        fs: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
