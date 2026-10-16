/**
 * Zero-dependency production preflight, shared by Next config and startup scripts.
 * Importing this module never validates, so builds do not require runtime keys.
 * @param {{ NODE_ENV?: string, AUTH_SECRET?: string }} [env]
 * @returns {void}
 */
export function assertProductionAuthSecret(env = process.env) {
  if (env.NODE_ENV !== "production") return;

  // Trim for validation only. Never mutate real encryption or session material.
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32 || secret === "dev-secret-change-me") {
    throw new Error(
      "AUTH_SECRET must be configured with at least 32 non-padding characters and must not use the example value in production.",
    );
  }
}
