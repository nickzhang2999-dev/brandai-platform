import { createHash } from "node:crypto";
import { prisma, Prisma } from "@brandai/db";
import { WorkbenchBrandDraft } from "@brandai/contracts";
import { StudioBrandDraftImportInput, StudioBrandDraftImportResult, StudioBrandDraftImportState } from "../../../../packages/contracts/src/studio-brand-knowledge";
import { ApiException } from "./api";
import { requireWorkspaceRole } from "./workspace";
import { lockBrandKnowledgeWorkspace } from "./brand-knowledge-safety";

const conflict = () => new ApiException(409, "品牌草稿已变更或导入请求不一致，请读取最新草稿后再导入。");

export async function readStudioBrandDraftImport(workspaceId: string, userId: string) {
  await requireWorkspaceRole(workspaceId, userId, "VIEWER");
  const draft = await prisma.workbenchBrandDraft.findUnique({ where: { workspaceId } });
  return StudioBrandDraftImportState.parse({ available: !!draft, draftRevision: draft?.revision ?? 0,
    importableTypes: draft ? ["color", "font"] : [], hasNotes: !!draft?.notes.trim() });
}

export async function importStudioBrandDraft(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioBrandDraftImportInput.parse(raw);
  await requireWorkspaceRole(workspaceId, userId, "EDITOR");
  const payloadHash = createHash("sha256").update(JSON.stringify({ expectedDraftRevision: input.expectedDraftRevision })).digest("hex");
  return prisma.$transaction(async tx => {
    // Same workspace row lock as shell draft saves, rule confirmation and restore.
    await lockBrandKnowledgeWorkspace(tx, workspaceId);
    const prior = await tx.workbenchKnowledgeImport.findUnique({ where: {
      workspaceId_userId_mutationId: { workspaceId, userId, mutationId: input.mutationId },
    } });
    if (prior) {
      if (prior.workspaceId !== workspaceId || prior.userId !== userId || prior.payloadHash !== payloadHash || prior.draftRevision !== input.expectedDraftRevision) throw conflict();
      const receipt = StudioBrandDraftImportResult.safeParse(prior.receipt);
      if (!receipt.success || receipt.data.mutationId !== input.mutationId || receipt.data.draftRevision !== prior.draftRevision) throw new ApiException(409, "导入回执异常，请联系管理员。");
      // Replay never recreates rules which a user subsequently edited or deleted.
      return { ...receipt.data, replayed: true };
    }
    const [draft, workspace] = await Promise.all([
      tx.workbenchBrandDraft.findUnique({ where: { workspaceId } }),
      tx.brandWorkspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
    ]);
    if (!draft || !workspace) throw new ApiException(404, "没有已保存的品牌草稿，请先保存草稿。");
    if (draft.revision !== input.expectedDraftRevision) throw conflict();
    const source = WorkbenchBrandDraft.safeParse({ name: workspace.name.slice(0, 60), colors: draft.colors, font: draft.font, notes: draft.notes });
    if (!source.success) throw new ApiException(422, "已保存的品牌草稿格式不受支持，原内容未修改。");
    const origin = { kind: "studio-brand-draft", mutationId: input.mutationId, draftRevision: draft.revision };
    const family = { system: "system-ui", sans: "sans-serif", serif: "serif", mono: "monospace" }[source.data.font];
    const color = await tx.brandRule.create({ data: { workspaceId, type: "color", strength: "WEAK", status: "DRAFT",
      summary: `草稿色彩：${source.data.colors.join("、")}`,
      value: { colors: source.data.colors, novartSource: origin },
      structured: { module: "color", palette: source.data.colors.map(hex => ({ hex })) }, evidence: [] } });
    const font = await tx.brandRule.create({ data: { workspaceId, type: "font", strength: "WEAK", status: "DRAFT",
      summary: `草稿字体类别：${family}（待确认具体字体）`,
      value: { fonts: [family], fontCategory: source.data.font, novartSource: origin },
      structured: { module: "font", fallback_fonts: [family], license_status: "UNKNOWN" }, evidence: [] } });
    const receipt = StudioBrandDraftImportResult.parse({ mutationId: input.mutationId, draftRevision: draft.revision,
      ruleIds: [color.id, font.id], created: 2, replayed: false, notesPreserved: !!source.data.notes });
    await tx.workbenchKnowledgeImport.create({ data: { workspaceId, userId, mutationId: input.mutationId,
      draftRevision: draft.revision, payloadHash, source: source.data as Prisma.InputJsonValue,
      receipt: receipt as Prisma.InputJsonValue, ruleIds: receipt.ruleIds, ruleCount: receipt.created } });
    return receipt;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 });
}
