// The API and new paid dispatches have independent switches.
export function isDeepFlareV2Enabled(workspaceId: string, env: NodeJS.ProcessEnv = process.env) {
  return env.DEEPFLARE_V2_ENABLED === "1"
    && (env.DEEPFLARE_V2_WORKSPACE_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean).includes(workspaceId);
}

export function nativeDispatchEnabled(workspaceId: string) {
  return process.env.DEEPFLARE_V2_NATIVE_DISPATCH === "1" && isDeepFlareV2Enabled(workspaceId);
}

export function posterPlanner(workspaceId: string): "dsh" | "company" | null {
  if (!isDeepFlareV2Enabled(workspaceId)) return null;
  if (process.env.SOL_DSH_ENABLED === "1") return "dsh";
  return nativeDispatchEnabled(workspaceId) ? "company" : null;
}
