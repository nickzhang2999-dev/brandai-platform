/** Runtime-only validation. Importing this module is safe during next build. */
export function assertProductionAuthSecret(
  env: Pick<NodeJS.ProcessEnv, "NODE_ENV" | "AUTH_SECRET"> = process.env,
): void {
  if (env.NODE_ENV !== "production") return;

  // Validate without changing key material. Trimming is only for validation;
  // changing the real value could invalidate sessions and encrypted settings.
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32 || secret === "dev-secret-change-me") {
    // Never include the supplied value in a startup error or diagnostic log.
    throw new Error(
      "AUTH_SECRET must be configured with at least 32 non-padding characters and must not use the example value in production.",
    );
  }
}
