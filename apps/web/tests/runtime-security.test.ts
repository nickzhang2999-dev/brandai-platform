import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionAuthSecret } from "../src/lib/runtime-security";
import { register } from "../src/instrumentation";
import configureNext from "../next.config.mjs";

afterEach(() => vi.unstubAllEnvs());
const valid = "synthetic-runtime-validation-secret-only";
const webRoot = fileURLToPath(new URL("..", import.meta.url));
const requireWeb = createRequire(new URL("../next.config.mjs", import.meta.url));
const { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER, PHASE_DEVELOPMENT_SERVER } = requireWeb("next/constants");

describe("production runtime AUTH_SECRET gate", () => {
  it.each([undefined, "", "short", "x".repeat(31), " ".repeat(40), `  ${"x".repeat(30)}  `, "dev-secret-change-me"])("rejects a missing, padded, short or example secret without echoing it (#%#)", value => {
    expect(() => assertProductionAuthSecret({ NODE_ENV: "production", AUTH_SECRET: value })).toThrow("AUTH_SECRET must be configured");
    try { assertProductionAuthSecret({ NODE_ENV: "production", AUTH_SECRET: value }); }
    catch (error) { if (value) expect(String(error)).not.toContain(value); }
  });
  it("rejects the tracked example, without reading an actual environment file", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8").match(/^AUTH_SECRET="([^"]*)"/m)?.[1];
    expect(example).toBeDefined();
    expect(() => assertProductionAuthSecret({ NODE_ENV: "production", AUTH_SECRET: example })).toThrow();
  });
  it("accepts 32 or more characters without modifying the supplied configuration", () => {
    const env = Object.freeze({ NODE_ENV: "production", AUTH_SECRET: ` ${valid} `, SETTINGS_ENC_KEY: "synthetic-encryption-key" });
    expect(() => assertProductionAuthSecret(env)).not.toThrow();
    expect(env.AUTH_SECRET).toBe(` ${valid} `); expect(env.SETTINGS_ENC_KEY).toBe("synthetic-encryption-key");
    expect(() => assertProductionAuthSecret({ NODE_ENV: "production", AUTH_SECRET: "x".repeat(32) })).not.toThrow();
  });
  it.each(["development", "test", undefined])("preserves local behavior in %s", environment => {
    expect(() => assertProductionAuthSecret({ NODE_ENV: environment })).not.toThrow();
  });
  it("validates from the Next startup hook, rather than at build-time module import", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("AUTH_SECRET", "");
    expect(() => register()).toThrow("AUTH_SECRET must be configured");
    vi.stubEnv("AUTH_SECRET", valid); expect(() => register()).not.toThrow();
  });
  it("validates the awaited production config phase without blocking build or development", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("AUTH_SECRET", "");
    expect(() => configureNext(PHASE_PRODUCTION_SERVER)).toThrow("AUTH_SECRET must be configured");
    expect(() => configureNext(PHASE_PRODUCTION_BUILD)).not.toThrow();
    expect(() => configureNext(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
    vi.stubEnv("AUTH_SECRET", valid); expect(() => configureNext(PHASE_PRODUCTION_SERVER)).not.toThrow();
  });
  it("imports the hook safely in a production build process without runtime secrets", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/instrumentation.ts"); console.log("import-safe")'], {
      cwd: webRoot, env: childEnv(), encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("import-safe");
  });
  it("rejects the actual worker entrypoint before creating any queue or health server", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/lib/workers/index.ts"], {
      cwd: webRoot, env: childEnv(), encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined(); expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("AUTH_SECRET must be configured");
    expect(child.stdout + child.stderr).not.toMatch(/ECONNREFUSED|health server on|started: .* worker/);
  });
  it("runs the dependency-free preflight before installation or migration is possible", () => {
    const child = spawnSync(process.execPath, ["scripts/check-runtime-security.mjs"], {
      cwd: webRoot, env: childEnv(), encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/^AUTH_SECRET must be configured[^\n]*\r?\n$/);
    expect(child.stdout).toBe("");
    for (const relative of ["scripts/web-startup.sh", "scripts/worker-startup.sh", "deploy/novart/start-web.sh"]) {
      const source = readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
      const commands = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
      expect(commands[0]).toMatch(/^set -eu?$/);
      expect(commands[1]).toBe("node apps/web/scripts/check-runtime-security.mjs");
    }
  });
  it.each(["", "synthetic-short", "dev-secret-change-me"])("rejects actual next start before Ready even without BUILD_ID (#%#)", secret => {
    const scratch = path.resolve(webRoot, "../../.novart-build");
    mkdirSync(scratch, { recursive: true });
    const fixture = mkdtempSync(path.join(scratch, "runtime-startup-test-"));
    try {
      // The fixture has no .env or build artifacts. It re-exports the real
      // application config, so the installed CLI must reject before BUILD_ID.
      const configUrl = new URL("../next.config.mjs", import.meta.url).href;
      writeFileSync(path.join(fixture, "next.config.mjs"), `export { default } from ${JSON.stringify(configUrl)};\n`);
      const env = childEnv(); env.AUTH_SECRET = secret;
      const child = spawnSync(process.execPath, [requireWeb.resolve("next/dist/bin/next"), "start", fixture, "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: fixture, env, encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
      expect(child.stderr).toContain("AUTH_SECRET must be configured");
      expect(child.stdout + child.stderr).not.toMatch(/Ready in|ECONNREFUSED|Could not find a production build|health server on|started: .* worker/);
    } finally {
      // Only remove this test's newly created, resolved directory inside scratch.
      if (path.dirname(fixture) !== scratch || !path.basename(fixture).startsWith("runtime-startup-test-")) throw new Error("Unexpected startup fixture path");
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 15_000);
});

// An explicit process whitelist prevents the child from inheriting database,
// Redis or provider configuration. tsx itself does not load .env files.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", AUTH_SECRET: "", NEXT_TELEMETRY_DISABLED: "1", NEXT_DEPLOYMENT_ID: "synthetic-startup-test",
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic", REDIS_URL: "redis://127.0.0.1:1", AI_SERVICE_URL: "http://127.0.0.1:1",
  };
  for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
