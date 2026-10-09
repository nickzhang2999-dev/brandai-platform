/** Opt-in build resources for constrained development machines; no runtime changes. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL("../", import.meta.url));
const temporary = fileURLToPath(new URL("../../../.novart-build/temporary/", import.meta.url));
await mkdir(temporary, { recursive: true });

// Heap limits are per Node process, not a promise about total system memory.
// Keep WebAssembly available; --jitless cannot build the Next production bundle.
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
  cwd,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    NOVART_LOW_MEMORY_BUILD: "1",
    NODE_OPTIONS: "--max-old-space-size=768 --max-semi-space-size=4",
    CIRCLE_NODE_TOTAL: "1",
    RAYON_NUM_THREADS: "1",
    UV_THREADPOOL_SIZE: "2",
    NEXT_TELEMETRY_DISABLED: "1",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
  },
});
child.on("error", () => { console.error("Unable to start the low-memory production build."); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
