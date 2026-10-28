import type { BrandRule } from "@brandai/contracts";

export function groupBrandKitRules(rules: BrandRule[]): { key: string; rules: BrandRule[] }[] {
  const groups = new Map<string, BrandRule[]>();
  for (const rule of rules) {
    // Legacy records do not carry a verified content hash. Never guess that
    // two unrelated assets are identical from their thumbnail or filename.
    const assets = [...new Set((rule.evidence ?? []).flatMap(item => item.assetId ? [item.assetId] : []))].sort();
    const key = assets.length ? `${rule.type}:assets:${JSON.stringify(assets)}` : `rule:${rule.id}`;
    const entries = groups.get(key) ?? []; entries.push(rule); groups.set(key, entries);
  }
  return [...groups].map(([key, grouped]) => ({ key, rules: grouped }));
}

export const BRAND_KIT_BATCH_LIMIT = 10;
export type BrandKitUploadEntry = { id: string; name: string; targetType?: string; file?: File; isPdf: boolean;
  assetId?: string; taskId?: string; terminal?: boolean; error?: string; rejected?: boolean; removable?: boolean; phase: "WAITING" | "UPLOADING" | "SUBMITTING" | "ACCEPTED" | "FAILED" };

export async function uniqueBrandKitFiles(files: File[]) {
  const accepted: File[] = [], seen = new Set<string>(); let duplicates = 0;
  for (const file of files) {
    const bytes = await file.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    if (seen.has(digest)) { duplicates++; continue; }
    seen.add(digest); accepted.push(file);
  }
  return { files: accepted, duplicates };
}
