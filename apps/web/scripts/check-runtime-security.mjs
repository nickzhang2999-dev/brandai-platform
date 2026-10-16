import { assertProductionAuthSecret } from "../runtime-security.mjs";

try {
  assertProductionAuthSecret();
} catch {
  // A constant diagnostic avoids printing configuration or an error stack.
  console.error("AUTH_SECRET must be configured with at least 32 non-padding characters and must not use the example value in production.");
  process.exitCode = 1;
}
