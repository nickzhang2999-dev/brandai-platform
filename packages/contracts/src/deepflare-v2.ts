import { z } from "zod";

// 2.0 protocol v1. External reference IDs are pointers, never proof of permission.
const Id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const Revision = z.number().int().min(1).max(2_147_483_646);
export const DeepFlareV2Scope = z.object({ workspaceId: Id, projectId: Id }).strict();
export type DeepFlareV2Scope = z.infer<typeof DeepFlareV2Scope>;
export const DeepFlareV2InspirationRef = z.object({
  source: z.literal("ommi"), caseId: Id, sourceVersion: z.string().min(1).max(128),
  insightIds: z.array(Id).min(1).max(8),
  application: z.string().min(1).max(1000),
}).strict();
export type DeepFlareV2InspirationRef = z.infer<typeof DeepFlareV2InspirationRef>;
export const DeepFlareV2Brief = z.object({
  text: z.string().min(1).max(8000),
  mode: z.enum(["DIRECTION_FIRST", "DIRECT"]),
  deliverables: z.array(z.object({
    id: Id, channel: z.string().min(1).max(100),
    width: z.number().int().min(32).max(8192),
    height: z.number().int().min(32).max(8192),
  }).strict()).min(1).max(6),
  inspiration: z.array(DeepFlareV2InspirationRef).max(8),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.deliverables.map(item => item.id)).size !== value.deliverables.length)
    ctx.addIssue({ code: "custom", path: ["deliverables"], message: "交付物编号不能重复" });
});
export type DeepFlareV2Brief = z.infer<typeof DeepFlareV2Brief>;
export const DeepFlareV2Direction = z.object({
  summary: z.string().min(1).max(1000),
  composition: z.string().min(1).max(3000),
}).strict();
export type DeepFlareV2Direction = z.infer<typeof DeepFlareV2Direction>;
export const DeepFlareV2CreateInput = z.object({
  mutationId: z.string().uuid(), brief: DeepFlareV2Brief,
}).strict();
export const DeepFlareV2Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SET_DIRECTION"), direction: DeepFlareV2Direction }).strict(),
  z.object({ type: z.literal("REVISE_BRIEF"), brief: DeepFlareV2Brief }).strict(),
  z.object({ type: z.literal("SUBMIT") }).strict(),
  z.object({ type: z.literal("CONFIRM_DIRECTION"), planVersion: Revision }).strict(),
  z.object({ type: z.literal("REQUEST_REVISION"), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ type: z.literal("CANCEL") }).strict(),
]);
export type DeepFlareV2Command = z.infer<typeof DeepFlareV2Command>;
export const DeepFlareV2CommandInput = z.object({
  mutationId: z.string().uuid(), expectedRevision: Revision, command: DeepFlareV2Command,
}).strict();
export const DeepFlareV2Task = z.object({
  id: Id, role: z.enum(["INSPIRATION", "COPYWRITING", "VISUAL", "ADAPTATION", "QA"]),
  dependsOn: z.array(Id).max(12),
  memoryKinds: z.array(z.enum(["INSPIRATION", "COPY", "VISUAL", "FEEDBACK"])).max(4),
  deliverableId: Id.nullable(),
}).strict();
export type DeepFlareV2Task = z.infer<typeof DeepFlareV2Task>;
export const DeepFlareV2State = z.object({
  protocolVersion: z.literal(1), revision: Revision, planVersion: Revision,
  status: z.enum(["DRAFT", "AWAITING_DIRECTION", "REVISION_REQUESTED", "READY", "CANCELLED"]),
  brief: DeepFlareV2Brief, direction: DeepFlareV2Direction.nullable(),
  approvedPlanVersion: Revision.nullable(), revisionReason: z.string().min(1).max(2000).nullable(),
  tasks: z.array(DeepFlareV2Task).min(4).max(9),
}).strict();
export type DeepFlareV2State = z.infer<typeof DeepFlareV2State>;
export const DeepFlareV2Receipt = z.object({
  id: Id, workspaceId: Id, projectId: Id, state: DeepFlareV2State,
  executionAvailable: z.literal(false),
}).strict();
export type DeepFlareV2Receipt = z.infer<typeof DeepFlareV2Receipt>;
