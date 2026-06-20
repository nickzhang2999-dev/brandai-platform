import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { z } from "zod";
import { prisma } from "@brandai/db";
import {
  ApiException,
  handleError,
  parse,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { getProject, getVersion } from "@/lib/generations";
import { getConfirmedRules } from "@/lib/rules";
import { canReleaseVersion } from "@brandai/contracts";

/**
 * M6 · 交付包导出 — POST { versionIds[] } streams a ZIP containing:
 *   images/<gen>-v<idx>.<ext>   — every selected version's image
 *   rules.json / rules.md       — the workspace's CONFIRMED brand rules
 *   compliance.json             — each exported version's complianceReport
 *   manifest.json               — project + export metadata
 *
 * Built with `archiver` streaming into a PassThrough so the ZIP is
 * produced incrementally (no full buffering). Works with zero AI keys —
 * mock images are public urls; an unreachable image is recorded in the
 * manifest as `imageError` instead of aborting the whole package.
 * Reads only; never mutates M3/M4/M5 state.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ExportInput = z.object({
  versionIds: z.array(z.string()).min(1),
});

function rulesMarkdown(
  rules: Awaited<ReturnType<typeof getConfirmedRules>>,
): string {
  const lines = ["# 品牌视觉规范（已确认）", ""];
  if (rules.length === 0) lines.push("_暂无已确认规则。_");
  for (const r of rules) {
    lines.push(
      `## ${r.type} · ${r.strength}`,
      "",
      r.summary,
      "",
      "```json",
      JSON.stringify(r.value, null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string; projectId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    const { role } = await requireWorkspaceRole(wsId, user.id, "REVIEWER");

    const project = await getProject(wsId, projectId);
    if (!project) throw new ApiException(404, "Project not found");

    const { versionIds } = parse(ExportInput, await req.json());

    // Resolve & ownership-check every requested version.
    const versions = [];
    for (const vid of versionIds) {
      const v = await getVersion(vid);
      if (!v) continue;
      const gen = await prisma.generation.findUnique({
        where: { id: v.generationId },
      });
      if (!gen || gen.workspaceId !== wsId || gen.projectId !== projectId) {
        continue;
      }
      // K2 — separation of duties: a non-owner collaborator may only export
      // RELEASED (final/approved) versions. The owner exports anything (the
      // phase-1 closed loop is unchanged). Unreleased drafts are silently
      // dropped for collaborators rather than 403-ing the whole ZIP.
      if (!canReleaseVersion(role, v)) continue;
      versions.push({ version: v, generation: gen });
    }
    if (versions.length === 0) {
      throw new ApiException(
        404,
        "No exportable versions in this project",
      );
    }

    const rules = await getConfirmedRules(wsId);

    const archive = archiver("zip", { zlib: { level: 9 } });
    const passthrough = new PassThrough();
    archive.on("warning", (e) => console.warn("[export] archiver", e));
    archive.on("error", (e) => console.error("[export] archiver", e));
    archive.pipe(passthrough);

    const manifest = {
      generatedAt: new Date().toISOString(),
      workspaceId: wsId,
      project,
      ruleCount: rules.length,
      versions: [] as Array<{
        versionId: string;
        generationId: string;
        index: number;
        imageFile: string;
        sceneType: string;
        sellingPoint: string;
        isFinal: boolean;
        hasComplianceReport: boolean;
        imageError?: string;
      }>,
      // E8 — Campaign Kit grouping: how many exported images per scene type,
      // so a delivered set reads as a structured kit, not a flat pile.
      scenes: [] as Array<{ sceneType: string; imageCount: number }>,
    };
    const compliance: Record<string, unknown> = {};

    for (const { version, generation } of versions) {
      // 扩展名必须从 fetch 回来的 content-type 推导,而不是 split(imageUrl, ".")：
      // 无存储/mock 流程下 imageUrl 是 data:image/svg+xml;base64,... ,按 "." 切会把
      // 整个 data URL 当成扩展名,生成含路径分隔符的畸形 ZIP 条目名。
      const baseName = `images/${generation.id}-v${version.index}`;
      let imageFile = `${baseName}.png`; // content-type 未知时的兜底名
      try {
        const res = await fetch(version.imageUrl);
        if (!res.ok || !res.body) {
          throw new Error(`upstream ${res.status}`);
        }
        const ct = (res.headers.get("content-type") ?? "").toLowerCase();
        const ext = ct.includes("svg")
          ? "svg"
          : ct.includes("jpeg") || ct.includes("jpg")
            ? "jpg"
            : ct.includes("webp")
              ? "webp"
              : ct.includes("gif")
                ? "gif"
                : "png";
        imageFile = `${baseName}.${ext}`;
        const buf = Buffer.from(await res.arrayBuffer());
        archive.append(buf, { name: imageFile });
        manifest.versions.push({
          versionId: version.id,
          generationId: generation.id,
          index: version.index,
          imageFile,
          sceneType: generation.sceneType,
          sellingPoint: generation.sellingPoint,
          isFinal: version.isFinal,
          hasComplianceReport: !!version.complianceReport,
        });
      } catch (e) {
        manifest.versions.push({
          versionId: version.id,
          generationId: generation.id,
          index: version.index,
          imageFile,
          sceneType: generation.sceneType,
          sellingPoint: generation.sellingPoint,
          isFinal: version.isFinal,
          hasComplianceReport: !!version.complianceReport,
          imageError: String(e),
        });
      }
      if (version.complianceReport) {
        compliance[version.id] = version.complianceReport;
      }
    }

    // Roll up the exported versions by scene type for the kit grouping.
    const sceneCounts = new Map<string, number>();
    for (const v of manifest.versions) {
      sceneCounts.set(v.sceneType, (sceneCounts.get(v.sceneType) ?? 0) + 1);
    }
    manifest.scenes = [...sceneCounts.entries()].map(([sceneType, imageCount]) => ({
      sceneType,
      imageCount,
    }));

    archive.append(JSON.stringify(rules, null, 2), {
      name: "rules.json",
    });
    archive.append(rulesMarkdown(rules), { name: "rules.md" });
    archive.append(JSON.stringify(compliance, null, 2), {
      name: "compliance.json",
    });
    archive.append(JSON.stringify(manifest, null, 2), {
      name: "manifest.json",
    });
    archive.finalize();

    const fileName = `delivery-${project.name.replace(/[^\w.-]+/g, "_")}.zip`;
    const webStream = Readable.toWeb(
      passthrough,
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(webStream, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
