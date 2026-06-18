import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrandCanvas,
  VisualAssetCard,
  BrandDNAPanel,
  AIInsightPanel,
  ConsistencyScoreCard,
} from "../src/business";

// Snapshot tests for P1.0 business components — guard against accidental
// className / structural drift while we migrate pages onto them.

describe("BrandCanvas", () => {
  it("renders eyebrow + title + children", () => {
    const html = renderToStaticMarkup(
      <BrandCanvas eyebrow="Workspace" title="Acme">
        <p>content</p>
      </BrandCanvas>,
    );
    expect(html).toMatchSnapshot();
  });
});

describe("VisualAssetCard", () => {
  it("renders with thumb + tags + meta", () => {
    const html = renderToStaticMarkup(
      <VisualAssetCard
        name="hero.png"
        thumbUrl="/u/hero.png"
        tags={["primary", "hero"]}
        meta="1920×1080 · 312 KB"
      />,
    );
    expect(html).toMatchSnapshot();
  });

  it("renders without thumb", () => {
    const html = renderToStaticMarkup(<VisualAssetCard name="noimg.png" />);
    expect(html).toMatchSnapshot();
  });
});

describe("BrandDNAPanel", () => {
  it("renders title + children", () => {
    const html = renderToStaticMarkup(
      <BrandDNAPanel title="Brand DNA" subtitle="auto-extracted">
        <div>inner</div>
      </BrandDNAPanel>,
    );
    expect(html).toMatchSnapshot();
  });
});

describe("AIInsightPanel", () => {
  it("renders conclusion + evidence + suggestions", () => {
    const html = renderToStaticMarkup(
      <AIInsightPanel
        conclusion="Palette drifts warm."
        evidence={["12/15 assets use gold"]}
        suggestions={["Lock muted-gold"]}
        tone="risk"
      />,
    );
    expect(html).toMatchSnapshot();
  });
});

describe("ConsistencyScoreCard", () => {
  it("renders pass/risk/danger tones by score", () => {
    expect(
      renderToStaticMarkup(
        <ConsistencyScoreCard label="Pass" score={90} />,
      ),
    ).toMatchSnapshot("pass");
    expect(
      renderToStaticMarkup(
        <ConsistencyScoreCard label="Risk" score={70} />,
      ),
    ).toMatchSnapshot("risk");
    expect(
      renderToStaticMarkup(
        <ConsistencyScoreCard label="Danger" score={40} hint="needs work" />,
      ),
    ).toMatchSnapshot("danger");
  });
});
