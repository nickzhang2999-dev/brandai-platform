import { execFileSync } from "node:child_process";

function resolveDeploymentId() {
  if (process.env.NEXT_DEPLOYMENT_ID) return process.env.NEXT_DEPLOYMENT_ID;
  // CDS injects the checked-out revision into every service. Prefer it over
  // spawning git because some preview builders expose the source tree without
  // its .git directory while still persisting the previous .next cache.
  if (process.env.CDS_COMMIT_SHA) return process.env.CDS_COMMIT_SHA.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "local";
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // CDS preview profiles may keep a Next dev process alive while pulling a new
  // commit. Without a deployment id, the stable /_next chunk URLs can pair new
  // server HTML with an older browser/CDN bundle and trigger hydration errors.
  // Next appends this commit id to asset URLs so every deployed tree is atomic.
  deploymentId: resolveDeploymentId(),
  transpilePackages: ["@brandai/ui", "@brandai/contracts", "@brandai/db"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
  // The container build OOMs during next build's in-process type-check phase.
  // We already gate every deploy on `tsc --noEmit` (and ESLint isn't configured),
  // so skip the redundant in-build checks to keep the build within memory.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
