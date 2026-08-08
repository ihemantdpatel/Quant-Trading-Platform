import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emits a self-contained server bundle so the Docker image can run without
  // a full node_modules tree.
  output: 'standalone',

  // Without this, Next infers a workspace root above this directory and nests
  // the bundle at `.next/standalone/ui/server.js`. Pinning the root to this
  // project flattens it to `.next/standalone/server.js`, so the Dockerfile's
  // COPY and CMD paths are stable rather than dependent on the build context.
  outputFileTracingRoot: projectDir,

  reactStrictMode: true,
};

export default nextConfig;
