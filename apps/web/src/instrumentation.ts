import { assertProductionAuthSecret } from "./lib/runtime-security";

// Next invokes register before serving requests, not when compiling/typegen.
// Keep validation inside the hook so runtime secrets need not exist in CI builds.
export function register(): void {
  assertProductionAuthSecret();
}
