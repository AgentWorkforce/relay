/** @type {import('next').NextConfig} */
const nextConfig = {
  // Output as standalone for easier deployment
  output: 'standalone',

  // Disable strict mode for now during development
  reactStrictMode: true,

  // Configure for dashboard subdirectory
  basePath: '/v2',

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
