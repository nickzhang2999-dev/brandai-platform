import type { StudioConversationMessage } from "@brandai/contracts";

type Message = StudioConversationMessage;
type Generation = NonNullable<Message["generation"]>;

/** Terminal failures and saved results must never create another poll timer. */
export function ownedConversationActive(message: Message) {
  if (message.status === "FAILED" || message.status === "CLARIFICATION") return false;
  const generation = message.generation;
  if (generation?.status === "FAILED" || generation?.resultState === "FAILED" || generation?.resultState === "READY") return false;
  return message.status === "PENDING" || message.status === "RUNNING"
    || generation?.status === "PENDING" || generation?.status === "RUNNING"
    || generation?.status === "SUCCEEDED" && (generation.resultState === "PENDING" || generation.resultState === "RUNNING");
}

/** Conversation intake, image generation and result storage have separate
 * server leases. A finished intake must not stop a newer generation/archive. */
export function ownedConversationDeadline(message: Message): number {
  const generation = message.generation;
  if (!generation) return Date.parse(message.expiresAt);
  if (generation.status === "SUCCEEDED" && (generation.resultState === "PENDING" || generation.resultState === "RUNNING")) {
    // archiveExpiresAt is provider-output retention, potentially days long,
    // not an active worker lease and must not cause unbounded polling.
    return Date.parse(generation.archiveProcessingExpiresAt ?? generation.expiresAt);
  }
  return Date.parse(generation.expiresAt);
}

/** An explicit archive retry updates its own existing message, using the most
 * recent message snapshot rather than the card's earlier render closure. */
export function ownedConversationGeneration(message: Message, generation: Generation): Message {
  const previous = message.generation;
  if (!previous || generation.projectId !== message.projectId || generation.requestId !== previous.requestId
    || generation.mutationId !== previous.mutationId || generation.generationId !== previous.generationId) {
    throw new Error("生成回执与原对话任务不一致，请读取最新记录。");
  }
  // A retry's earlier PENDING response can arrive after the conversation poll
  // has already confirmed READY. An archived result cannot regress to pending.
  if (previous.resultState === "READY" && generation.resultState !== "READY") return message;
  const failed = generation.status === "FAILED" || generation.resultState === "FAILED";
  const status = failed ? "FAILED" : generation.status === "SUCCEEDED" && generation.resultState === "READY" ? "SUCCEEDED" : "RUNNING";
  const error = generation.status === "FAILED" ? generation.error ?? message.error
    : generation.resultState === "FAILED" ? generation.archiveError ?? message.error : null;
  return { ...message, generation, status, error };
}
