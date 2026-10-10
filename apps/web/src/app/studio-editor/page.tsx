import { redirect } from "next/navigation";
import { prisma } from "@brandai/db";
import { ApiException } from "@/lib/api";
import { EditorDocumentError } from "@/lib/editor-document-codec";
import { readEditorDocument } from "@/lib/editor-documents";
import { studioSession } from "@/lib/studio-session";
import { studioTaskIntent } from "@/lib/studio-task-intent";
import { OwnedEditorClient } from "@/components/owned-canvas/OwnedEditorClient";

export const dynamic = "force-dynamic";

/** The same permission checks protect direct visits and the reviewed shell's iframe. */
export default async function OwnedEditorPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const name of ["workspaceId", "projectId"]) {
    if (typeof params[name] === "string") query.set(name, params[name]);
  }
  for (const name of ["taskId", "requestId"]) {
    const value = params[name];
    for (const id of typeof value === "string" ? [value] : value ?? []) query.append(name, id);
  }
  const callback = "/studio-editor?" + query.toString();
  try {
    const { user, workspaceId } = await studioSession(new Request("http://novart.internal" + callback));
    const projectId = query.get("projectId") ?? "";
    const document = await readEditorDocument(workspaceId, projectId, user.id);
    const initialTask = studioTaskIntent(query);
    const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { name: true } });
    return <OwnedEditorClient workspaceId={workspaceId} projectId={projectId} userId={user.id}
      readOnly={document.readOnly} projectName={project?.name ?? "项目画布"} initialTask={initialTask} />;
  } catch (error) {
    if (error instanceof ApiException || error instanceof EditorDocumentError) {
      if (error.status === 401) redirect("/login?callbackUrl=" + encodeURIComponent(callback));
      return <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg p-8 text-fg">
        <p role="alert" data-testid="owned-editor-access-error">{error.message}</p>
        <a className="rounded-full bg-primary px-5 py-2 text-primary-fg" href={"/studio?" + new URLSearchParams(query.has("workspaceId") ? { workspaceId: query.get("workspaceId")! } : {}) + "#/projects"} target="_top">返回项目库</a>
      </main>;
    }
    throw error;
  }
}
