import { ZodError } from "zod";
import { ApiException } from "./api";
import { studioSession } from "./studio-session";
import { studioAsset, studioHtml, studioLicenseConfig } from "./studio-assets";
import { readWorkbenchJson } from "./workbench-request";
import { isWorkbenchSameOrigin } from "./workbench-origin";
import { EditorDocumentError } from "./editor-document-codec";
import { readEditorDocument } from "./editor-documents";
import * as state from "./studio-state";
import { readStudioWorkflow, readStudioWorkflowAssets, saveStudioWorkflow, studioWorkflowImage } from "./studio-workflow";
import { submitStudioMaterial, readStudioMaterialUpload, listStudioMaterials } from "./studio-materials";
import { submitStudioGeneration, readStudioGeneration } from "./studio-generation";
import { retryStudioGenerationArtifacts } from "./studio-generation-artifacts";
import { readStudioGenerationCompliance, retryStudioGenerationCompliance } from "./studio-generation-compliance";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });

export async function studioRoute(req: Request) {
  const url = new URL(req.url), pathname = url.pathname;
  try {
    // Only immutable manifest-listed scripts/styles/fonts/images are public.
    if (req.method === "GET" && /\.(js|css|png|svg|woff2?|ttf|jpg|webp|json|wasm|wav)$/.test(pathname)) {
      const file = await studioAsset(pathname);
      return file ? new Response(new Uint8Array(file.bytes), { headers: { ...headers, "Content-Type": file.mime } }) : json({ error: "Not found" }, 404);
    }
    const identity = await studioSession(req, !["/studio", "/studio/", "/compare"].includes(pathname));
    const { user, workspaceId, session } = identity;
    if (["/studio", "/studio/", "/canvas"].includes(pathname) && req.method === "GET") {
      let readOnly = false;
      if (pathname === "/canvas") {
        const doc = await readEditorDocument(workspaceId, url.searchParams.get("projectId") ?? "", user.id);
        readOnly = doc.readOnly;
      }
      const asset = await studioAsset(pathname === "/canvas" ? "/canvas.html" : "/studio.html", true);
      if (!asset) throw new ApiException(503, "工作台资源尚未构建。");
      return new Response(studioHtml(asset.bytes.toString("utf8"), { ...session, workspaceId, readOnly, canvasLicense: studioLicenseConfig() }), {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" },
      });
    }
    if (req.method !== "GET" && !isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    const project = { projectId: url.searchParams.get("projectId") ?? "" };
    if (req.method === "GET") {
      if (pathname.startsWith("/workflow/image/")) {
        const location = await studioWorkflowImage(workspaceId, user.id, project, pathname.slice("/workflow/image/".length));
        return new Response(null, { status: 307, headers: { ...headers, Location: location } });
      }
      switch (pathname) {
        case "/compare": return new Response(null, { status: 302, headers: { Location: `/studio${workspaceId ? "?workspaceId=" + encodeURIComponent(workspaceId) : ""}#/projects`, ...headers } });
        case "/studio/state": return json(await state.readStudioState(workspaceId, user.id));
        case "/studio/project-library": case "/compare/api/projects": return json(await state.studioProjects(workspaceId, user.id));
        case "/compare/api/context": return json(await state.studioContext(workspaceId, user.id, project));
        case "/compare/api/status": return json(await state.studioStatus(workspaceId, user.id, project));
        case "/studio/draft": return json(await state.studioDraft(workspaceId, user.id, project));
        case "/studio/start/job": await readEditorDocument(workspaceId, project.projectId, user.id); return json({ error: "当前项目没有带图创建任务。" }, 404);
        case "/workflow": return json(await readStudioWorkflow(workspaceId, user.id, project));
        case "/workflow/assets": return json(await readStudioWorkflowAssets(workspaceId, user.id, project));
        case "/studio/materials": return json(await listStudioMaterials(workspaceId, user.id, project));
        case "/studio/material-upload": return json(await readStudioMaterialUpload(workspaceId, user.id,
          { ...project, ...(url.searchParams.has("taskId") ? { taskId: url.searchParams.get("taskId") } : {}) }));
        case "/studio/generation": return json(await readStudioGeneration(workspaceId, user.id,
          { ...project, ...(url.searchParams.has("requestId") ? { requestId: url.searchParams.get("requestId") } : {}) }));
        case "/studio/generation/compliance": return json(await readStudioGenerationCompliance(workspaceId, user.id,
          { ...project, versionId: url.searchParams.get("versionId") ?? "" }));
      }
    }
    if (req.method === "POST") {
      if (pathname === "/studio/material-upload") return json(await submitStudioMaterial(workspaceId, user.id, req), 202);
      if (!['/studio/state', '/compare/api/create', '/compare/api/context', '/studio/project-archive', '/studio/draft', '/workflow', '/studio/generation', '/studio/generation/retry-archive', '/studio/generation/compliance/retry'].includes(pathname)) throw new ApiException(503, "此功能正在接入，内容仍保留在当前页面。");
      const body = await readWorkbenchJson(req, 270 * 1024);
      switch (pathname) {
        case "/studio/state": return json(await state.saveStudioState(workspaceId, user.id, body));
        case "/compare/api/create": return json(await state.createStudioProject(workspaceId, user.id, body));
        case "/compare/api/context": return json(await state.saveStudioContext(workspaceId, user.id, body));
        case "/studio/project-archive": return json(await state.archiveStudioProject(workspaceId, user.id, body));
        case "/studio/draft": return json(await state.saveStudioDraft(workspaceId, user.id, body));
        case "/workflow": return json(await saveStudioWorkflow(workspaceId, user.id, body));
        case "/studio/generation": return json(await submitStudioGeneration(workspaceId, user.id, body), 202);
        case "/studio/generation/compliance/retry": return json(await retryStudioGenerationCompliance(workspaceId, user.id, body), 202);
        case "/studio/generation/retry-archive": {
          await retryStudioGenerationArtifacts(workspaceId, user.id, body);
          return json(await readStudioGeneration(workspaceId, user.id, body), 202);
        }
      }
    }
    if (/^\/(studio|workflow|compare)(?:\/|$)/.test(pathname)) throw new ApiException(503, "此功能正在接入，尚未提交操作。请保留当前内容。");
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof ApiException || error instanceof EditorDocumentError) {
      if (error.status === 401 && req.method === "GET" && ["/studio", "/canvas"].includes(pathname)) {
        return new Response(null, { status: 302, headers: { ...headers, Location: "/login?callbackUrl=" + encodeURIComponent(url.pathname + url.search) } });
      }
      return json({ error: error.message }, error.status);
    }
    if (error instanceof ZodError) return json({ error: "请求内容格式不正确，请检查后重试。" }, 422);
    return json({ error: "工作台暂时无法读取，请稍后重试。" }, 503);
  }
}
