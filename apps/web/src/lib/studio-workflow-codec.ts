import { gunzipSync } from "node:zlib";
import { EDITOR_DOCUMENT_PREFIX, EDITOR_DOCUMENT_MAX_DECODED_BYTES } from "@brandai/contracts";
import { StudioWorkflowAssets, StudioWorkflowIssue, StudioWorkflowSaveInput } from "../../../../packages/contracts/src/studio-workflow";
import { inspectEditorDocument } from "./editor-document-codec";

/** This list must come from authenticated, project-scoped persistent records. */
export type WorkflowMaterial = { sha256: string; url: string; mimeType: string };
export function workflowAssets(projectId: string, canvas: string, materials: WorkflowMaterial[]): StudioWorkflowAssets {
  const assets: StudioWorkflowAssets["assets"] = [], issues: StudioWorkflowIssue[] = [];
  if (!canvas) return StudioWorkflowAssets.parse({ projectId, assets, issues });
  inspectEditorDocument(canvas);
  const document = JSON.parse(gunzipSync(Buffer.from(canvas.slice(EDITOR_DOCUMENT_PREFIX.length), "base64"),
    { maxOutputLength: EDITOR_DOCUMENT_MAX_DECODED_BYTES }).toString("utf8"));
  const byUrl = new Map<string, WorkflowMaterial | null>();
  for (const material of materials) {
    const prior = byUrl.get(material.url);
    if (byUrl.has(material.url) && (!prior || prior.sha256 !== material.sha256 || prior.mimeType !== material.mimeType)) {
      byUrl.set(material.url, null);
    } else byUrl.set(material.url, material);
  }
  const dimension = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  for (const [id, value] of Object.entries(document.tldrawSnapshot.document.store)) {
    const shape = value as { id?: unknown; typeName?: unknown; type?: unknown; props?: Record<string, unknown> } | null;
    if (!shape || shape.typeName !== "shape" || shape.type !== "c-image") continue;
    if (shape.id !== id || id.length > 200 || !/^shape:[\x21-\x7e]+$/.test(id) || id.includes("\n")
      || !shape.props || typeof shape.props !== "object" || Array.isArray(shape.props)) {
      issues.push({ code: "INVALID_IMAGE_SHAPE", scope: "asset", shapeId: null, assetSha256: null,
        message: "画布中有一张图片的记录无法识别，原内容仍保留，请检查后重新插入。", blocking: true });
      continue;
    }
    const props = shape.props;
    const material = typeof props.url === "string" ? byUrl.get(props.url) : undefined;
    if (!material) {
      issues.push({ code: material === null ? "AMBIGUOUS_MATERIAL" : "UNVERIFIED_MATERIAL", scope: "asset", shapeId: id, assetSha256: null,
        message: "画布图片尚未关联到当前项目的持久化素材，请重新上传或选择素材。", blocking: true });
      continue;
    }
    assets.push({ shapeId: id, assetSha256: material.sha256,
      name: typeof props.name === "string" && props.name ? props.name.slice(0, 255) : "画布图片",
      width: dimension(props.w), height: dimension(props.h), valid: true, mime: material.mimeType });
  }
  return StudioWorkflowAssets.parse({ projectId, assets, issues });
}

export function workflowReferenceIssue(
  reference: { shapeId: string | null; assetSha256: string }, assets: StudioWorkflowAssets["assets"],
  scope: "reference" | "target", blocking: boolean, index?: number,
): StudioWorkflowIssue | null {
  const current = reference.shapeId === null ? assets.find(asset => asset.assetSha256 === reference.assetSha256)
    : assets.find(asset => asset.shapeId === reference.shapeId);
  if (current?.assetSha256 === reference.assetSha256 && current.valid) return null;
  return { shapeId: reference.shapeId, assetSha256: reference.assetSha256, scope, blocking, ...(index === undefined ? {} : { index }),
    code: !current ? "REFERENCE_MISSING" : "SHAPE_ASSET_CHANGED",
    message: "原图片已删除、替换或不再可用；已保留原引用，请明确移除或重新选择。" };
}

export function workflowIssues(value: Pick<StudioWorkflowSaveInput, "references" | "target">, assets: StudioWorkflowAssets["assets"]) {
  const issues: StudioWorkflowIssue[] = [];
  value.references.forEach((reference, index) => {
    const issue = workflowReferenceIssue(reference, assets, "reference", reference.participates, index);
    if (issue) issues.push(issue);
  });
  if (value.target) {
    const issue = workflowReferenceIssue(value.target, assets, "target", true);
    if (issue) issues.push(issue);
  }
  return issues;
}

/** Existing invalid references may be retained/disabled, never silently changed. */
export function assertWorkflowSelection(next: StudioWorkflowSaveInput, current: StudioWorkflowSaveInput, assets: StudioWorkflowAssets["assets"]) {
  for (const reference of next.references) {
    if (!workflowReferenceIssue(reference, assets, "reference", reference.participates)) continue;
    const old = current.references.find(item => item.shapeId === reference.shapeId && item.assetSha256 === reference.assetSha256);
    if (!old || (reference.participates && !old.participates)) return false;
  }
  if (next.target && workflowReferenceIssue(next.target, assets, "target", true)) {
    if (current.mode !== "modify" || current.target?.shapeId !== next.target.shapeId || current.target.assetSha256 !== next.target.assetSha256) return false;
  }
  return true;
}
