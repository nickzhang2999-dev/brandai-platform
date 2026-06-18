/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@brandai/ui", "@brandai/contracts", "@brandai/db"],
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }, { protocol: "http", hostname: "**" }] },
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  // The container build OOMs during next build's in-process type-check phase.
  // We already gate every deploy on `tsc --noEmit` (and ESLint isn't configured),
  // so skip the redundant in-build checks to keep the build within memory.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
