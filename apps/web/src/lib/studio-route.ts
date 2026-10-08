import { ZodError } from "zod";
import { ApiException } from "./api";
import { studioSession } from "./studio-session";
import { studioAsset, studioHtml } from "./studio-assets";
import { readWorkbenchJson } from "./workbench-request";
import { isWorkbenchSameOrigin } from "./workbench-origin";
import { EditorDocumentError, inspectEditorDocument } from "./editor-document-codec";
import { readEditorDocument } from "./editor-documents";
import * as state from "./studio-state";
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
      return new Response(studioHtml(asset.bytes.toString("utf8"), { ...session, workspaceId, readOnly }), {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" },
      });
    }
    if (req.method !== "GET" && !isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    const project = { projectId: url.searchParams.get("projectId") ?? "" };
    if (req.method === "GET") {
      switch (pathname) {
        case "/compare": return new Response(null, { status: 302, headers: { Location: `/studio${workspaceId ? "?workspaceId=" + encodeURIComponent(workspaceId) : ""}#/projects`, ...headers } });
        case "/studio/state": return json(await state.readStudioState(workspaceId, user.id));
        case "/studio/project-library": case "/compare/api/projects": return json(await state.studioProjects(workspaceId, user.id));
        case "/compare/api/context": return json(await state.studioContext(workspaceId, user.id, project));
        case "/compare/api/status": return json(await state.studioStatus(workspaceId, user.id, project));
        case "/studio/draft": return json(await state.studioDraft(workspaceId, user.id, project));
        case "/studio/start/job": await readEditorDocument(workspaceId, project.projectId, user.id); return json({ error: "当前项目没有带图创建任务。" }, 404);
        case "/workflow/assets": {
          const doc = await readEditorDocument(workspaceId, project.projectId, user.id);
          if (doc.canvas && inspectEditorDocument(doc.canvas).urls.length) throw new ApiException(503, "素材库同步正在接入，已保存的画布内容仍保留。");
          return json({ ...project, assets: [], issues: [] });
        }
      }
    }
    if (req.method === "POST") {
      if (!['/studio/state', '/compare/api/create', '/compare/api/context', '/studio/project-archive', '/studio/draft'].includes(pathname)) throw new ApiException(503, "此功能正在接入，内容仍保留在当前页面。");
      const body = await readWorkbenchJson(req, 270 * 1024);
      switch (pathname) {
        case "/studio/state": return json(await state.saveStudioState(workspaceId, user.id, body));
        case "/compare/api/create": return json(await state.createStudioProject(workspaceId, user.id, body));
        case "/compare/api/context": return json(await state.saveStudioContext(workspaceId, user.id, body));
        case "/studio/project-archive": return json(await state.archiveStudioProject(workspaceId, user.id, body));
        case "/studio/draft": return json(await state.saveStudioDraft(workspaceId, user.id, body));
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
