import { execFileSync } from "node:child_process";
import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { assertProductionAuthSecret } from "./runtime-security.mjs";

const lowMemoryBuild = process.env.NOVART_LOW_MEMORY_BUILD === "1";

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
  // PSD encoding runs in a terminable Node worker. Keep the installed module
  // available to that worker instead of bundling it into the Next handler.
  serverExternalPackages: ["ag-psd"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "10mb" },
    // Next clones bodies before route handlers. Preserve the legacy 50 MiB
    // document upload plus multipart headers; both upload handlers still bound
    // their own actual stream. Studio's independent image limit stays 10 MiB,
    // and legacy image uploads stay 8 MiB (see asset-upload-policy).
    middlewareClientMaxBodySize: 50 * 1024 * 1024 + 64 * 1024,
    ...(lowMemoryBuild ? {
      cpus: 1,
      webpackMemoryOptimizations: true,
      webpackBuildWorker: true,
      parallelServerCompiles: false,
      parallelServerBuildTraces: false,
    } : {}),
  },
  // The container build OOMs during next build's in-process type-check phase.
  // We already gate every deploy on `tsc --noEmit`, so keep that duplicate
  // type-check separate. ESLint also runs in CI and remains enabled in builds.
  typescript: { ignoreBuildErrors: true },
};
/** @param {string} phase */
export default function configureNext(phase) {
  // Config loading is awaited before Next reports Ready. Instrumentation alone
  // can fail after production's lazy prepare has already opened the listener.
  if (phase === PHASE_PRODUCTION_SERVER) assertProductionAuthSecret();
  return nextConfig;
}
