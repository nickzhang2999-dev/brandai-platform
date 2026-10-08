import { z } from "zod";
import { NativeProjectName, NativeProjectQueryInput, NativeProjectVersion } from "./native-project";

const revision = z.number().int().min(0).max(2147483646);
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
export const WorkbenchContextSaveInput = NativeProjectQueryInput.extend({ revision, brief: z.string().max(6000), notes: z.string().max(4000) }).strict();
export const WorkbenchArchiveInput = NativeProjectQueryInput.extend({ archived: z.boolean(), revision, projectVersion: NativeProjectVersion }).strict();
export const WorkbenchDraftSaveInput = NativeProjectQueryInput.extend({ revision, inputForm: z.record(z.unknown()).nullable() }).strict();
