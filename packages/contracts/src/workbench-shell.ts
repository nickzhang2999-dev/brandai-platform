import { z } from "zod";
import { NativeProjectName, NativeProjectQueryInput, NativeProjectVersion } from "./native-project";

const revision = z.number().int().min(0).max(2147483646);
// Shell payloads contain a project identity only. Native transport metadata
// (such as cid) must not leak into the shell's stricter save boundary.
const WorkbenchProjectReference = NativeProjectQueryInput.pick({ projectId: true }).strict();
export const WorkbenchProfile = z.object({
  nickname: z.string().max(40), density: z.enum(["comfortable", "compact"]), motion: z.enum(["system", "reduce"]),
}).strict();
export const WorkbenchBrandDraft = z.object({
  name: z.string().trim().min(1).max(60), colors: z.array(z.string().length(7).regex(/^#[a-fA-F0-9]{6}$/)).length(3),
  font: z.enum(["system", "sans", "serif", "mono"]), notes: z.string().max(2000),
}).strict();
export const WorkbenchShellState = z.object({
  revision, profile: WorkbenchProfile, brand: WorkbenchBrandDraft,
  favorites: z.array(NativeProjectQueryInput.shape.projectId).max(100),
}).strict();
export const WorkbenchShellSaveInput = WorkbenchShellState.extend({ group: z.enum(["profile", "brand", "favorites"]) }).strict();
export const WorkbenchProjectCreateInput = z.object({ projectName: NativeProjectName, brief: z.string().max(6000), requestId: z.string().uuid() }).strict();
export const WorkbenchContextSaveInput = WorkbenchProjectReference.extend({ revision, brief: z.string().max(6000), notes: z.string().max(4000) }).strict();
export const WorkbenchArchiveInput = WorkbenchProjectReference.extend({ archived: z.boolean(), revision, projectVersion: NativeProjectVersion }).strict();
// The native restore path requires text, and owns all other composer fields.
// Preserve those fields verbatim instead of stripping them during validation.
export const WorkbenchDraftForm = z.object({ text: z.string() }).passthrough();
export const WorkbenchDraftSaveInput = WorkbenchProjectReference.extend({ revision, inputForm: WorkbenchDraftForm.nullable() }).strict();
export const WorkbenchDraftReferenceIssue = z.object({
  code: z.string(), message: z.string(), label: z.string(),
  assetSha256: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  identity: z.object({ kind: z.enum(["key", "elementId"]), value: z.string() }).strict().nullable(),
}).strict();
/** Both GET and POST /studio/draft use the same checked receipt. */
export const WorkbenchDraftView = WorkbenchProjectReference.extend({
  // A final accepted save can advance the maximum writable revision by one.
  revision: z.number().int().min(0).max(2147483647),
  inputForm: WorkbenchDraftSaveInput.shape.inputForm,
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  referenceIssues: z.array(WorkbenchDraftReferenceIssue),
}).strict();
export type WorkbenchDraftView = z.infer<typeof WorkbenchDraftView>;
