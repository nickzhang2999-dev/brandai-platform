// scripts/cds-preinstall.cjs — root `preinstall` hook (earliest point in the
// geole.me CDS run-chain: `corepack enable && pnpm install && …`).
//
// On CDS (CDS_BUILD_PLACEHOLDER set) spawn the readiness placeholder DETACHED so
// the port responds within seconds of the chain starting — long BEFORE the cold
// `next build` finishes — letting CDS's ~248s readiness probe pass mid-chain so
// the container isn't reaped (see scripts/build-placeholder.cjs for the why).
// scripts/web-build.sh kills it after `next build`, freeing the port for the
// chain's `next start`.
//
// Local + CI installs (no CDS_BUILD_PLACEHOLDER) → no-op, so `pnpm install` is
// unchanged everywhere else.
if (!process.env.CDS_BUILD_PLACEHOLDER) process.exit(0);

const { spawn, spawnSync } = require("child_process");
const path = require("path");

// Idempotent: if a placeholder is already up (e.g. a retried install), do nothing.
try {
  const r = spawnSync("pgrep", ["-f", "build-placeholder.cjs"], { stdio: "ignore" });
  if (r.status === 0) process.exit(0);
} catch {
  /* pgrep absent — just spawn; a double-bind would simply EADDRINUSE-exit */
}

const child = spawn(
  process.execPath,
  [path.join(__dirname, "build-placeholder.cjs")],
  { detached: true, stdio: "ignore" },
);
child.unref(); // survive this preinstall process exiting
console.log("[cds-preinstall] readiness placeholder spawned (detached)");
process.exit(0);
