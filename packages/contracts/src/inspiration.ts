import { z } from 'zod';

export const InspirationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const InspirationCaseCard = z.object({
  caseId: InspirationId, revision: z.number().int().positive(), title: z.string(), summary: z.string(), brandOrTeam: z.string(), analysisAllowed: z.boolean(),
  tags: z.record(z.array(z.string())),
  images: z.array(z.object({ imageId: InspirationId, url: z.string() })),
  sources: z.array(z.object({ sourceId: InspirationId, url: z.string() })),
  claims: z.array(z.object({ claimId: InspirationId, kind: z.enum(['author_statement','media_statement','visual_observation','analysis_inference']), text: z.string(), sourceIds: z.array(InspirationId), imageIds: z.array(InspirationId) })),
});
export type InspirationCaseCard = z.infer<typeof InspirationCaseCard>;
export const InspirationListResponse = z.object({
  enabled: z.boolean(), syncConfigured: z.boolean(), activeRelease: z.object({ id: InspirationId, sequence: z.number().int(), createdAt: z.string() }).nullable(),
  caseCount: z.number().int(), withdrawalSequence: z.number().int(), lastSyncAt: z.string().nullable(), error: z.string().nullable(),
  cases: z.array(InspirationCaseCard), searchMode: z.enum(['keyword-tags','hybrid']),
});
export type InspirationListResponse = z.infer<typeof InspirationListResponse>;
export const InspirationSelectedImage = z.object({caseId:InspirationId,imageId:InspirationId,revision:z.number().int().positive()}).strict();
export const InspirationChatInput = z.object({ requestId: z.string().uuid(), question: z.string().trim().min(1).max(3000), conversationId: z.string().uuid().optional(), caseIds: z.array(InspirationId).max(8).optional(),selectedImages:z.array(InspirationSelectedImage).max(2).optional() }).strict();
export type InspirationChatInput = z.infer<typeof InspirationChatInput>;
export const InspirationChatState = z.object({ id: z.string(), conversationId: z.string(), status: z.enum(['PENDING','RUNNING','SUCCEEDED','FAILED']), question: z.string(), answer: z.string().nullable(), citations: z.array(InspirationCaseCard), error: z.string().nullable(), createdAt: z.string() });
export type InspirationChatState = z.infer<typeof InspirationChatState>;
export const InspirationBookmarkInput = z.object({ caseId: InspirationId, revision: z.number().int().positive(), projectId: z.string().min(1).max(128).optional(), note: z.string().trim().max(2000).default('') }).strict();
export const InspirationBookmark = z.object({ id: z.string(), caseId: InspirationId, revision: z.number().int().positive(), projectId: z.string().nullable(), note: z.string(), case: InspirationCaseCard.nullable(), unavailable: z.boolean() });
export type InspirationBookmark = z.infer<typeof InspirationBookmark>;

export const InspirationFeedbackKind = z.enum(['IRRELEVANT','ANALYSIS_ERROR','UNSUPPORTED_CITATION','BROKEN_IMAGE']);
export const InspirationFeedbackInput = z.object({caseId:InspirationId,revision:z.number().int().positive(),kind:InspirationFeedbackKind,note:z.string().trim().max(1000).default('')}).strict();
export type InspirationFeedbackInput = z.infer<typeof InspirationFeedbackInput>;
export const InspirationFeedback = z.object({id:z.string(),caseId:InspirationId,revision:z.number().int().positive(),kind:InspirationFeedbackKind,note:z.string(),status:z.enum(['OPEN','RESOLVED']),createdAt:z.string(),caseTitle:z.string().nullable(),unavailable:z.boolean()});
export type InspirationFeedback = z.infer<typeof InspirationFeedback>;
export const InspirationFeedbackList = z.object({items:z.array(InspirationFeedback),scope:z.enum(['mine','review']),canReview:z.boolean()});
export type InspirationFeedbackList = z.infer<typeof InspirationFeedbackList>;
export const InspirationFeedbackUpdate = z.object({status:z.enum(['OPEN','RESOLVED'])}).strict();
export const InspirationActivityItem=z.object({id:z.string(),conversationId:z.string(),status:z.enum(['PENDING','RUNNING','SUCCEEDED','FAILED']),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),expiresAt:z.string().datetime(),expired:z.boolean()});
export type InspirationActivityItem=z.infer<typeof InspirationActivityItem>;
export const InspirationActivity=z.object({enabled:z.boolean(),items:z.array(InspirationActivityItem).max(20)});
export type InspirationActivity=z.infer<typeof InspirationActivity>;
