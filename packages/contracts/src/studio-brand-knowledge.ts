import { z } from "zod";

/** Studio-only protocol. The revision is WorkbenchBrandDraft.revision, not shell revision. */
export const StudioBrandDraftImportInput = z.object({
  mutationId: z.string().uuid(),
  expectedDraftRevision: z.number().int().min(1).max(2147483646),
}).strict();
export type StudioBrandDraftImportInput = z.infer<typeof StudioBrandDraftImportInput>;

export const StudioBrandDraftImportState = z.object({
  available: z.boolean(),
  draftRevision: z.number().int().min(0).max(2147483646),
  importableTypes: z.array(z.enum(["color", "font"])).max(2),
  hasNotes: z.boolean(),
}).strict();
export type StudioBrandDraftImportState = z.infer<typeof StudioBrandDraftImportState>;

export const StudioBrandDraftImportResult = z.object({
  mutationId: z.string().uuid(),
  draftRevision: z.number().int().min(1).max(2147483646),
  ruleIds: z.array(z.string().min(1)).length(2),
  created: z.literal(2),
  replayed: z.boolean(),
  notesPreserved: z.boolean(),
}).strict();
export type StudioBrandDraftImportResult = z.infer<typeof StudioBrandDraftImportResult>;
