// The foundation has no paid executor and never enables itself by branch name.
export function isDeepFlareV2Enabled(workspaceId: string, env: NodeJS.ProcessEnv = process.env) {
  return env.DEEPFLARE_V2_ENABLED === "1"
    && (env.DEEPFLARE_V2_WORKSPACE_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean).includes(workspaceId);
}
