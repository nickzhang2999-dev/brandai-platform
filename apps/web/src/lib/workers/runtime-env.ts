import { assertProductionAuthSecret } from "../runtime-security";

// This module must be the first entrypoint dependency. Reject invalid production
// configuration before any worker import creates a Redis connection or consumer.
assertProductionAuthSecret();
