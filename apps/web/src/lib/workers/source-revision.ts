import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
/** Immutable images carry their SHA in the build environment. Only mounted
 * Git checkouts can drift underneath an already-running module graph. */
export function watchSourceRevision(commit: string | undefined, shutdown: () => Promise<void>, root = "/app",
  run = () => exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000, maxBuffer: 4096 })) {
  if (!commit || !existsSync(join(root, ".git"))) return () => {};
  let running = false, stopping = false, warned = false;
  const timer = setInterval(() => {
    if (running || stopping) return;
    running = true;
    void run().then(async ({ stdout }) => {
      warned = false;
      const current = stdout.trim();
      if (/^[a-f0-9]{40}$/.test(current) && current !== commit) {
        stopping = true; clearInterval(timer);
        console.log("[workers] mounted source changed; restarting");
        await shutdown();
      }
    }).catch((error: unknown) => {
      if (!warned) console.warn("[workers] mounted source revision check unavailable");
      warned = true;
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") clearInterval(timer);
    }).finally(() => { running = false; });
  }, 15_000);
  timer.unref();
  return () => { stopping = true; clearInterval(timer); };
}
