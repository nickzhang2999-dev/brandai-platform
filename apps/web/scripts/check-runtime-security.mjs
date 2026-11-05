import { assertProductionAuthSecret } from "../runtime-security.mjs";
import { assertRuntimeDataScope } from "../runtime-data-scope.mjs";

try {
  assertProductionAuthSecret();
} catch {
  // A constant diagnostic avoids printing configuration or an error stack.
  console.error("AUTH_SECRET must be configured with at least 32 non-padding characters and must not use the example value in production.");
  process.exitCode = 1;
}
if (!process.exitCode) {
  try { assertRuntimeDataScope(); }
  catch { console.error("Isolated runtime database or queue scope does not match deployment configuration."); process.exitCode = 1; }
}
