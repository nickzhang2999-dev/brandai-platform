import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/deepflare-v2-database.integration.ts"], environment: "node", maxWorkers: 1, minWorkers: 1 },
});
