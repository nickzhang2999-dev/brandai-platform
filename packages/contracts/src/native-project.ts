import { z } from "zod";
import { EditorDocumentSaveInput } from "./editor-document";

// Compatibility boundary for the reviewed native editor. Authentication and
// workspace selection come from our server session, never from vendor tokens.
const projectId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).refine(value => !value.includes("\n"));
// The captured HTTP client adds a bounded correlation id to every request.
// This is transport metadata, never an identity, permission or save version.
const cid = z.string().min(1).max(128).optional();
export const NativeProjectQueryInput = z.object({ projectId, cid }).strict();
export const NativeProjectListInput = z.object({
  cid,
  page: z.number().int().min(1).max(1000000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
}).strict();
export const NativeProjectName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
export const NativeProjectRenameInput = z.object({ projectId, cid, projectName: NativeProjectName }).strict();
export const NativeProjectVersion = z.string().regex(/^novart-(0|[1-9][0-9]{0,9})$/)
  .refine(value => value.trim() === value && Number(value.slice(7)) <= 2147483646, "Invalid document revision");
export const NativeProjectSaveInput = z.object({
  projectId,
  cid,
  canvas: EditorDocumentSaveInput.shape.canvas,
  version: NativeProjectVersion,
  // Native full-save sends these derived/display values. The stored document
  // is authoritative; an autosave must not undo a separate project rename.
  projectName: NativeProjectName.optional(),
  projectCoverList: z.array(z.string().max(4096)).max(20).optional(),
  picCount: z.number().int().min(0).max(1000000).optional(),
  projectType: z.literal(3).optional(),
  sessionId: z.string().max(128).optional(),
  canvasV2Gray: z.literal(false).optional(),
  canvasEvidenceEnabled: z.literal(false).optional(),
}).strict();
export type NativeProjectSaveInput = z.infer<typeof NativeProjectSaveInput>;
