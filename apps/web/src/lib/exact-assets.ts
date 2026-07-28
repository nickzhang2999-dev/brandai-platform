import {
  ExactAssetTransform as ExactAssetTransformSchema,
  type ExactAssetTransform,
} from "@brandai/contracts";
import type sharp from "sharp";

type SharpFactory = typeof sharp;

export type ResolvedExactAssetLayer = {
  assetId: string;
  assetUrl: string;
  assetMimeType?: string;
  transform: ExactAssetTransform;
};

const DATA_URL_RE = /^data:([^;,]+)(;base64)?,(.*)$/s;

function dataUrlToBuffer(input: string): Buffer | null {
  const match = DATA_URL_RE.exec(input);
  if (!match) return null;
  return Buffer.from(match[3] ?? "", match[2] ? "base64" : "utf8");
}

async function loadImageBytes(src: string): Promise<Buffer> {
  const data = dataUrlToBuffer(src);
  if (data) return data;
  const res = await fetch(src);
  if (!res.ok)
    throw new Error(`failed to fetch exact asset image: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

async function renderLayer(
  sharpFactory: SharpFactory,
  layer: ResolvedExactAssetLayer,
  canvas: { width: number; height: number },
): Promise<{ input: Buffer; left: number; top: number } | null> {
  const transform = ExactAssetTransformSchema.parse(layer.transform);
  const source = await loadImageBytes(layer.assetUrl);
  const metadata = await sharpFactory(source).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`exact asset ${layer.assetId} has no readable dimensions`);
  }

  const targetWidth = Math.max(
    1,
    Math.round(canvas.width * transform.widthRatio),
  );
  const resized = await sharpFactory(source)
    .resize({ width: targetWidth, withoutEnlargement: false })
    .png()
    .toBuffer();
  const resizedMeta = await sharpFactory(resized).metadata();
  if (!resizedMeta.width || !resizedMeta.height) return null;
  const cropLeft = clampInt(
    resizedMeta.width * transform.crop.left,
    0,
    resizedMeta.width - 1,
  );
  const cropTop = clampInt(
    resizedMeta.height * transform.crop.top,
    0,
    resizedMeta.height - 1,
  );
  const cropRight = clampInt(
    resizedMeta.width * transform.crop.right,
    0,
    resizedMeta.width - cropLeft - 1,
  );
  const cropBottom = clampInt(
    resizedMeta.height * transform.crop.bottom,
    0,
    resizedMeta.height - cropTop - 1,
  );
  const cropVisibleWidth = resizedMeta.width - cropLeft - cropRight;
  const cropVisibleHeight = resizedMeta.height - cropTop - cropBottom;
  const cropMask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${resizedMeta.width}" height="${resizedMeta.height}"><rect x="${cropLeft}" y="${cropTop}" width="${cropVisibleWidth}" height="${cropVisibleHeight}" fill="#fff"/></svg>`,
  );
  let pipeline = sharpFactory(resized)
    .ensureAlpha()
    .composite([{ input: cropMask, blend: "dest-in" }]);
  if (transform.flipX) pipeline = pipeline.flop();
  if (transform.rotationDeg !== 0) {
    pipeline = pipeline.rotate(transform.rotationDeg, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }
  const rendered = await pipeline.png().toBuffer();
  const renderedMeta = await sharpFactory(rendered).metadata();
  if (!renderedMeta.width || !renderedMeta.height) return null;

  const rawLeft = Math.round(
    canvas.width * transform.xRatio - renderedMeta.width / 2,
  );
  const rawTop = Math.round(
    canvas.height * transform.yRatio - renderedMeta.height / 2,
  );
  const sourceLeft = Math.max(0, -rawLeft);
  const sourceTop = Math.max(0, -rawTop);
  const left = Math.max(0, rawLeft);
  const top = Math.max(0, rawTop);
  const visibleWidth = Math.min(
    renderedMeta.width - sourceLeft,
    canvas.width - left,
  );
  const visibleHeight = Math.min(
    renderedMeta.height - sourceTop,
    canvas.height - top,
  );
  if (visibleWidth <= 0 || visibleHeight <= 0) return null;

  const clipped =
    sourceLeft > 0 ||
    sourceTop > 0 ||
    visibleWidth < renderedMeta.width ||
    visibleHeight < renderedMeta.height
      ? await sharpFactory(rendered)
          .extract({
            left: sourceLeft,
            top: sourceTop,
            width: visibleWidth,
            height: visibleHeight,
          })
          .png()
          .toBuffer()
      : rendered;
  return { input: clipped, left, top };
}

/**
 * Composites identity-locked assets after AI generation/editing. The provider
 * never receives these source pixels; only explicit crop/scale/rotation/flip
 * geometry is applied here.
 */
export async function applyExactAssetLayers(
  imageUrl: string,
  layers: ResolvedExactAssetLayer[],
): Promise<{ imageUrl: string; appliedAssetIds: string[] }> {
  if (layers.length === 0) return { imageUrl, appliedAssetIds: [] };
  const sharpModule = await import("sharp");
  const sharpFactory = sharpModule.default as SharpFactory;
  const base = await loadImageBytes(imageUrl);
  const metadata = await sharpFactory(base).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("generated base image has no readable dimensions");
  }

  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  const appliedAssetIds: string[] = [];
  const sorted = [...layers].sort(
    (a, b) => a.transform.zIndex - b.transform.zIndex,
  );
  for (const layer of sorted) {
    const rendered = await renderLayer(sharpFactory, layer, {
      width: metadata.width,
      height: metadata.height,
    });
    if (!rendered) {
      throw new Error(
        `exact asset ${layer.assetId} is fully outside the output frame`,
      );
    }
    composites.push(rendered);
    appliedAssetIds.push(layer.assetId);
  }

  const output = await sharpFactory(base)
    .composite(composites)
    .png()
    .toBuffer();
  return {
    imageUrl: `data:image/png;base64,${output.toString("base64")}`,
    appliedAssetIds,
  };
}
