import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BrandRule } from "@brandai/contracts";
import { RuleCard } from "../src/components/brand-knowledge/BrandKnowledgeEditor";

function render(mimeType?: string) {
  const rule = { id: "rule", workspaceId: "brand", type: "layout", summary: "Design guideline", value: {},
    evidence: [{ assetId: "source", mimeType, note: "Source observation", page: 2 }],
    strength: "WEAK", status: "DRAFT", createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z" } as BrandRule;
  return renderToStaticMarkup(React.createElement(RuleCard, { rule, wsId: "brand", busy: false, canEdit: false,
    openRuleMenu: null, setOpenRuleMenu: vi.fn(), onEdit: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(), onPreview: vi.fn() }));
}

describe("brand evidence card rendering", () => {
  it("renders PDF evidence as a source document with page provenance and a normal source link", () => {
    const html = render("application/pdf");
    expect(html).not.toContain("<img"); expect(html).toContain("来源为 PDF 手册");
    expect(html).toContain("第 2 页"); expect(html).toContain("查看来源文件");
    expect(html).toContain('/api/workspaces/brand/assets/source/raw');
  });
  it("keeps raster image evidence as an authenticated image preview", () => {
    const html = render("image/jpeg");
    expect(html).toContain("<img"); expect(html).not.toContain("来源为 PDF 手册");
  });
  it("does not guess an image when legacy metadata is unavailable", () => {
    expect(render()).not.toContain("<img"); expect(render("image/svg+xml")).not.toContain("<img");
  });
});
