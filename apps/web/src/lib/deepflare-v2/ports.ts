import type { DeepFlareV2InspirationRef, DeepFlareV2Scope, DeepFlareV2State, DeepFlareV2Task } from "@brandai/contracts";

/** Scope and actor originate from the authenticated server, never from an LLM. */
export type V2ActorScope = DeepFlareV2Scope & { userId: string };
export type MemoryKind = DeepFlareV2Task["memoryKinds"][number];
export type ConfirmedMemory = {
  id: string; version: number; scope: DeepFlareV2Scope; kind: MemoryKind; text: string;
  status: "CONFIRMED"; evidenceVersionIds: string[];
};
export type ResolvedInspiration = {
  reference: DeepFlareV2InspirationRef; scope: DeepFlareV2Scope;
  provenanceUrl: string; insightText: string; contentHash: string;
  permittedUse: "TEXT_REFERENCE"; checkedAt: string;
};

export interface OmmiPort {
  // Resolve exact version and insight selection; recheck access before each paid step.
  resolve(scope: V2ActorScope, references: DeepFlareV2InspirationRef[], signal: AbortSignal): Promise<ResolvedInspiration[]>;
}
export interface DesignMemoryPort {
  readConfirmed(scope: V2ActorScope, kinds: MemoryKind[], signal: AbortSignal): Promise<ConfirmedMemory[]>;
  // Feedback becomes a candidate. Confirmation/revocation requires a separate human action.
  propose(scope: V2ActorScope, candidate: { text: string; kind: MemoryKind; evidenceVersionIds: string[] },
    signal: AbortSignal): Promise<{ candidateId: string; status: "CANDIDATE" }>;
}
export interface DesignEmployeePort {
  execute(input: {
    scope: V2ActorScope; workOrderId: string; plan: DeepFlareV2State; task: DeepFlareV2Task;
    idempotencyKey: string; deadlineAt: string; signal: AbortSignal;
  }): Promise<{ taskId: string; receiptId: string; status: "ACCEPTED" }>;
}
export class V2IntegrationUnavailable extends Error {
  constructor(public readonly integration: string) { super(`${integration} 尚未接入`); }
}

/** Deliberately fail closed; no empty success, private Ommi code, guessed URL or provider. */
export const disconnectedOmmi: OmmiPort = {
  async resolve(_scope, references) {
    if (references.length === 0) return [];
    throw new V2IntegrationUnavailable("Ommi");
  },
};
export const disconnectedMemory: DesignMemoryPort = {
  async readConfirmed() { throw new V2IntegrationUnavailable("设计记忆宫殿"); },
  async propose() { throw new V2IntegrationUnavailable("设计记忆宫殿"); },
};
export const disconnectedEmployee: DesignEmployeePort = {
  async execute() { throw new V2IntegrationUnavailable("AI 员工执行器"); },
};
