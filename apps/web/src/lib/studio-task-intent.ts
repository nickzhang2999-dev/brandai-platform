import { ApiException } from "./api";

export type StudioTaskIntent = { kind: "STUDIO_UPLOAD" | "STUDIO_GENERATION"; id: string };

/** A link identifies an existing task; its authenticated API verifies ownership. */
export function studioTaskIntent(query: URLSearchParams): StudioTaskIntent | undefined {
  const uploads = query.getAll("taskId"), generations = query.getAll("requestId");
  if (!uploads.length && !generations.length) return undefined;
  if (uploads.length + generations.length !== 1) throw new ApiException(422, "任务地址不完整，请从任务列表重新打开。");
  const id = uploads[0] ?? generations[0];
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ApiException(422, "任务地址不完整，请从任务列表重新打开。");
  return { kind: uploads.length ? "STUDIO_UPLOAD" : "STUDIO_GENERATION", id };
}
