import archiver from "archiver";
import sharp from "sharp";
import { writePsd, type Layer, type Psd } from "ag-psd";
import { prisma } from "@brandai/db";
import {
  canExportFlattened,
  canExportLayeredDocument,
} from "@brandai/contracts";
import type { LayerSetView, LayerView } from "@brandai/contracts";
import { ApiException, handleError, requireUser } from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { serializeLayerSet } from "@/lib/layers";
import { safeFetch } from "@/lib/ssrf";

/**
 * 图层组导出:PSD（真分层）/ ZIP（逐层 PNG）/ PNG（合成图）。
 *
 * 三个出口的开关**不共用一个判据**——这是 prd_agent 踩过的一条:它三个出口共用
 * 「有没有可见层」，于是「把所有眼睛都关掉」这种合法状态把 PSD 也禁掉了。而
 * 分层文档恰恰是那种状态下唯一仍然成立的产物:隐藏层照样写进去并标记隐藏。
 *
 * 排序只有一个口径（`serializeLayerSet` 已按 z→index 排好），所以导出的层序与
 * 画布、面板必然一致。
 */
export const dynamic = "force-dynamic";

async function loadBytes(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!match || !match[2]) throw new ApiException(400, "无法读取图层数据");
    return Buffer.from(match[3] ?? "", "base64");
  }
  const res = await safeFetch(url);
  if (!res.ok) throw new ApiException(502, `图层读取失败 (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadSet(
  wsId: string,
  genId: string,
  setId: string,
): Promise<LayerSetView> {
  const generation = await prisma.generation.findUnique({ where: { id: genId } });
  if (!generation || generation.workspaceId !== wsId) {
    throw new ApiException(404, "Generation not found");
  }
  const rows = await prisma.generationVersion.findMany({
    where: {
      generationId: genId,
      params: { path: ["layerSetId"], equals: setId },
    },
    select: {
      id: true,
      imageUrl: true,
      width: true,
      height: true,
      params: true,
      createdAt: true,
    },
    orderBy: { index: "asc" },
  });
  const view = serializeLayerSet(setId, genId, rows);
  if (!view) throw new ApiException(404, "Layer set not found");
  return view;
}

function canvasSize(layers: LayerView[]): { width: number; height: number } {
  return {
    width: Math.max(1, ...layers.map((l) => l.width)),
    height: Math.max(1, ...layers.map((l) => l.height)),
  };
}

async function buildPsd(view: LayerSetView): Promise<Buffer> {
  const { width, height } = canvasSize(view.layers);
  const children: Layer[] = [];

  for (const layer of view.layers) {
    const raw = await sharp(await loadBytes(layer.imageUrl))
      .ensureAlpha()
      .resize(width, height, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    children.push({
      name: `第 ${layer.index + 1} 层${layer.thin ? "（细）" : ""}`,
      // 隐藏层照样写进文档并标记隐藏——用户在 Photoshop 里打开还能把它打开。
      hidden: layer.hidden,
      opacity: layer.opacity,
      left: 0,
      top: 0,
      imageData: {
        width: raw.info.width,
        height: raw.info.height,
        data: new Uint8ClampedArray(raw.data),
      },
    });
  }

  const psd: Psd = { width, height, children };
  return Buffer.from(writePsd(psd));
}

async function buildFlattened(view: LayerSetView): Promise<Buffer> {
  const visible = view.layers.filter((l) => !l.hidden);
  const { width, height } = canvasSize(view.layers);
  const composites = [];
  for (const layer of visible) {
    let img = sharp(await loadBytes(layer.imageUrl))
      .ensureAlpha()
      .resize(width, height, { fit: "fill" });
    if (layer.opacity < 1) {
      // 不透明度作用在 alpha 通道上,合成结果才和画布看到的一致。
      img = img.composite([
        {
          input: Buffer.from([255, 255, 255, Math.round(layer.opacity * 255)]),
          raw: { width: 1, height: 1, channels: 4 },
          tile: true,
          blend: "dest-in",
        },
      ]);
    }
    composites.push({ input: await img.png().toBuffer() });
  }
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function buildZip(view: LayerSetView): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", () => resolve());
    archive.on("error", reject);
  });
  for (const layer of view.layers.filter((l) => !l.hidden)) {
    archive.append(await loadBytes(layer.imageUrl), {
      name: `layer-${String(layer.index + 1).padStart(2, "0")}.png`,
    });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export async function GET(
  req: Request,
  {
    params,
  }: { params: Promise<{ wsId: string; genId: string; setId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId, setId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const view = await loadSet(wsId, genId, setId);

    const format = (
      new URL(req.url).searchParams.get("format") || "psd"
    ).toLowerCase();
    const stem = `layers-${setId.slice(0, 8)}`;

    if (format === "psd") {
      if (!canExportLayeredDocument(view.layers)) {
        throw new ApiException(400, "这一组没有可导出的图层产物");
      }
      const body = await buildPsd(view);
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": "image/vnd.adobe.photoshop",
          "content-disposition": `attachment; filename="${stem}.psd"`,
        },
      });
    }

    if (!canExportFlattened(view.layers)) {
      throw new ApiException(
        400,
        "所有图层都被隐藏了，合成图与打包没有内容可导；PSD 仍可导出",
      );
    }

    if (format === "png") {
      const body = await buildFlattened(view);
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": "image/png",
          "content-disposition": `attachment; filename="${stem}.png"`,
        },
      });
    }

    if (format === "zip") {
      const body = await buildZip(view);
      return new Response(new Uint8Array(body), {
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="${stem}.zip"`,
        },
      });
    }

    throw new ApiException(400, "format 仅支持 psd / zip / png");
  } catch (err) {
    return handleError(err);
  }
}
