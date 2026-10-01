/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.PROOFDESK_BUILD_DIR || '.next',
  output: 'standalone',
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
  experimental: {
    serverComponentsExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  },
};

export default nextConfig;
