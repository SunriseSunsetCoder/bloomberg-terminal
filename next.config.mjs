/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module — keep it external so Next never tries to
  // bundle the .node binary into the serverless trace (v1.3 JACK persistence).
  serverExternalPackages: ["better-sqlite3"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Re-enabled after the ai@4 downgrade cleared the AI-route type errors — the
    // build now fails on type errors instead of shipping broken code (which is how
    // the /api/ai runtime crash slipped through for so long).
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
