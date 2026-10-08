import { z } from "zod";

/** Full native editor documents deliberately do not use CanvasStateSchema. */
export const EDITOR_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const EDITOR_DOCUMENT_MAX_DECODED_BYTES = 32 * 1024 * 1024;
export const EDITOR_DOCUMENT_PREFIX = "SHAKKERDATA://";
export const EditorDocumentFormat = z.literal("novart-native-v1");
export const EditorDocumentSaveInput = z.object({
  format: EditorDocumentFormat,
  canvas: z.string().min(1).max(EDITOR_DOCUMENT_MAX_BYTES)
    .startsWith(EDITOR_DOCUMENT_PREFIX),
  // 0 creates the first document. Every subsequent save must use the revision read.
  revision: z.number().int().min(0).max(2147483646),
  // Retrying a lost response uses the same mutationId and identical payload.
  mutationId: z.string().uuid(),
}).strict();
export type EditorDocumentSaveInput = z.infer<typeof EditorDocumentSaveInput>;

export const EditorDocumentView = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  format: EditorDocumentFormat,
  canvas: z.string(),
  revision: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  updatedAt: z.string().datetime().nullable(),
  readOnly: z.boolean(),
}).strict();
export type EditorDocumentView = z.infer<typeof EditorDocumentView>;
