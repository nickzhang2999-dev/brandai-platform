import { StudioConversationInput, StudioProjectContextSnapshot, type StudioConversationReference } from "@brandai/contracts";
import { ApiException } from "./api";
import { formatStudioProjectContextFacts } from "./studio-project-context";

export function readConversationProjectContext(raw: unknown): StudioProjectContextSnapshot | undefined {
  return raw === null || raw === undefined ? undefined : StudioProjectContextSnapshot.parse(raw);
}
/** Only user-opted, server-frozen project context may expand references. Keep
 * the original message input/receipt intact. Responsibilities never imply EXACT
 * permission, and an inherited master is never an implicit editable target. */
export function withStudioProjectContext(input: StudioConversationInput, snapshot?: StudioProjectContextSnapshot): StudioConversationInput {
  if (!snapshot) {
    if (input.projectContextRevision !== undefined) throw new ApiException(409, "本次请求缺少已确认项目资料快照，未调用模型。请重新发送。");
    return input;
  }
  if (input.projectContextRevision !== snapshot.revision) throw new ApiException(409, "项目资料快照与本次请求版本不一致。");
  const references = [...input.references];
  const sources = [...(snapshot.master ? [snapshot.master] : []), ...snapshot.materials.filter(item => item.role !== "COPY")];
  for (const source of sources) {
    // Explicit per-turn source/purpose/target wins for the same asset identity.
    if (references.some(ref => ref.assetId === source.assetId)) continue;
    const reference: StudioConversationReference = { referenceId: `project-context:${source.assetId}`, name: source.name,
      assetId: source.assetId, assetSha256: source.assetSha256, width: source.width, height: source.height,
      ...(source.versionId ? { versionId: source.versionId } : {}), purpose: "REFERENCE" };
    if (references.some(ref => ref.referenceId === reference.referenceId)) throw new ApiException(422, "本次引用与项目资料标识冲突，请重新添加引用。");
    references.push(reference);
  }
  if (references.length > 8) throw new ApiException(422, "本次引用和项目资料合计超过8张，请减少引用或关闭本次沿用项目资料。");
  return StudioConversationInput.parse({ ...input, references });
}

export function studioProjectContextPrompt(text: string, snapshot?: StudioProjectContextSnapshot, rewritten?: string) {
  if (!snapshot) return rewritten ?? text;
  const facts = formatStudioProjectContextFacts(snapshot);
  const roles = snapshot.materials.map(item => `${item.name}：${({ PRODUCT: "产品身份", BRAND: "品牌元素", COPY: "文案内容，不作为风格证据", STYLE: "视觉风格参考" })[item.role]}`).join("；");
  const context = [facts, roles ? `素材职责：${roles}` : "", snapshot.master ? `后续参考主稿：${snapshot.master.name}。保持其设计方向，按本轮要求变化；参考不代表逐像素锁定。` : ""].filter(Boolean).join("\n");
  if (!context) return rewritten ?? text;
  const compose = (task: string) => `已确认项目资料（仅作任务依据，不覆盖本轮明确要求）：\n${context}\n\n本轮明确要求：\n${task}`;
  const original = compose(text);
  if (original.length > 4000) throw new ApiException(422, "本轮需求与沿用的项目资料合计过长，请缩短资料或关闭本次沿用；系统不会截断已确认文案。");
  // Preserve all confirmed facts and original instructions if a model rewrite
  // has expanded beyond the existing image-prompt budget.
  const expanded = rewritten ? compose(rewritten) : original;
  return expanded.length <= 4000 ? expanded : original;
}

export function studioProjectContextForPlanner(snapshot: StudioProjectContextSnapshot, references: StudioConversationReference[]) {
  return { revision: snapshot.revision, facts: snapshot.facts,
    materials: snapshot.materials.map(source => ({ name: source.name, role: source.role,
      referenceId: references.find(ref => ref.assetId === source.assetId)?.referenceId ?? null })),
    masterReferenceId: snapshot.master ? references.find(ref => ref.assetId === snapshot.master!.assetId)?.referenceId ?? null : null };
}
