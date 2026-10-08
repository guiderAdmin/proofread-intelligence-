import nextConstants from "next/constants.js";

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  // Development and production must never overwrite each other's webpack
  // manifests while a local dev server is running.
  distDir: '.next',
  // Only data: URLs are rendered via next/image, so the optimizer endpoint is
  // unused. Disabling it closes the Next 14 Image Optimizer advisories
  // (AVIF RCE / DoS) without requiring a breaking upgrade to Next 15.
  images: { unoptimized: true },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
  experimental: {
    // Native / worker-thread packages must stay in node_modules. If webpack
    // bundles tesseract.js, its worker path (__dirname/worker-script/node)
    // points to a file that doesn't exist and OCR silently fails.
    serverComponentsExternalPackages: ["@napi-rs/canvas", "pdfjs-dist", "tesseract.js", "tesseract.js-core"],
    // Vercel's file tracer can't see files opened via runtime-built paths
    // (pdf.js fonts/cmaps via process.cwd(), tesseract's Worker script and
    // WASM). Without these, they are missing from the serverless bundle.
    outputFileTracingIncludes: {
      "/api/**/*": [
        "./node_modules/pdfjs-dist/standard_fonts/**/*",
        "./node_modules/pdfjs-dist/cmaps/**/*",
        "./src/server/services/ocr-child.cjs",
        "./node_modules/tesseract.js/src/**/*",
        "./node_modules/tesseract.js-core/**/*",
      ],
    },
  },
};

export default (phase) => ({
  ...nextConfig,
  distDir: process.env.PROOFDESK_BUILD_DIR ||
    (phase === nextConstants.PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next'),
});
