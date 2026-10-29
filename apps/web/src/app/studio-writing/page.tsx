import OwnedEditorPage from "../studio-editor/page";

export const dynamic = "force-dynamic";

/** A shareable writing entry uses the same authenticated project shell and the
 * existing canvas save protocol for the optional, explicit final handoff. */
export default async function StudioWritingPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { taskId, ...rest } = params;
  return OwnedEditorPage({ searchParams: Promise.resolve({ ...rest, ...(typeof taskId === "string" ? { writingTaskId: taskId } : {}), surface: "writing" }) });
}
