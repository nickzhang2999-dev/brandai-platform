import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionAuthSecret } from "../../../apps/web/src/lib/runtime-security";
import { register } from "../../../apps/web/src/instrumentation";

afterEach(() => vi.unstubAllEnvs());
const valid = "synthetic-runtime-validation-secret-only";
const webRoot = fileURLToPath(new URL("../../../apps/web", import.meta.url));

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
});

// An explicit process whitelist prevents the child from inheriting database,
// Redis or provider configuration. tsx itself does not load .env files.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", AUTH_SECRET: "", NEXT_TELEMETRY_DISABLED: "1" };
  for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
