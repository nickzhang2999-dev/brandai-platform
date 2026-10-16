/** Canonical product links. Missing projects open the picker, never a broken editor. */
export function studioEditorHref(input: { workspaceId?: string | null; projectId?: string | null }): string {
  const query = new URLSearchParams();
  if (input.workspaceId) query.set("workspaceId", input.workspaceId);
  if (input.projectId) query.set("projectId", input.projectId);
  const suffix = query.size ? `?${query}` : "";
  return input.projectId ? `/studio-editor${suffix}` : `/studio${suffix}#/projects`;
}

/** Old Generation rows are not native canvas documents. Open their real image. */
export function generatedImageHref(workspaceId: string, generationId: string): string {
  return `/generated?${new URLSearchParams({ workspaceId, generationId })}`;
}

/** Redirect only known legacy product routes; APIs and admin routes are untouched. */
export function legacyStudioLocation(pathname: string, search: URLSearchParams): string | null {
  const query = new URLSearchParams(search);
  if (pathname === "/") return `/studio${query.size ? `?${query}` : ""}`;
  if (pathname === "/workspace" || pathname === "/workspace/") {
    const projectId = query.get("projectId") || query.get("project");
    query.delete("project");
    if (projectId) query.set("projectId", projectId);
    return projectId ? `/studio-editor?${query}` : studioEditorHref({ workspaceId: query.get("workspaceId") });
  }
  if (pathname === "/workspaces" || pathname === "/workspaces/") {
    return studioEditorHref({ workspaceId: query.get("workspaceId") });
  }
  const parts = pathname.replace(/\/$/, "").split("/");
  if (parts[1] !== "workspaces" || !parts[2]) return null;
  let workspaceId: string;
  try { workspaceId = decodeURIComponent(parts[2]); } catch { return null; }
  query.set("workspaceId", workspaceId);
  const section = parts[3];
  if (section === "projects" && parts[4] && parts.length === 5) {
    let projectId: string;
    try { projectId = decodeURIComponent(parts[4]); } catch { return null; }
    return studioEditorHref({ workspaceId, projectId });
  }
  if (section === "generations" && parts[4] && parts[5] === "versions" && parts[6] && parts[7] === "edit" && parts.length === 8) {
    // Legacy versions remain available in the generated-image library. They
    // must not be mistaken for an already saved native canvas document.
    try {
      query.set("generationId", decodeURIComponent(parts[4]));
      query.set("versionId", decodeURIComponent(parts[6]));
    } catch { return null; }
    return `/generated?${query}`;
  }
  if (parts.length > 4) return null;
  const destinations: Record<string, string> = {
    rules: "/brand-knowledge", compliance: "/brand-knowledge", assets: "/assets",
    members: "/members", projects: "/campaigns",
  };
  if (section && destinations[section]) return `${destinations[section]}?${query}`;
  if (!section || section === "generate") return studioEditorHref({ workspaceId, projectId: query.get("projectId") || query.get("project") });
  return null;
}
