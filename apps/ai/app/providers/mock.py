"""Deterministic mock provider — lets the whole P0 loop run with no API keys."""
import base64
import hashlib
import io
from typing import Any

from PIL import Image, ImageDraw

from .base import (
    ImageProvider,
    LayerProvider,
    ProviderCheck,
    VLMProvider,
    clamp_layer_count,
)

_MOCK_CHECK_DETAIL = "mock (无 key,占位模式)"

_PALETTE = ["#16130f", "#b9986a", "#f4efe6", "#8a6c45", "#d8cfbc"]


def _placeholder(seed: str, w: int, h: int) -> str:
    """Self-contained branded placeholder as an SVG `data:` URL.

    Returns a `data:image/svg+xml` URL (not an external link) so mock-generated
    images ALWAYS render — offline, in CI, in a sandbox — instead of depending
    on a third-party placeholder host. The web worker keeps SVG data URLs inline
    (see lib/s3.ts), so no object storage is needed for the demo to look right.
    """
    h8 = hashlib.sha1(seed.encode()).hexdigest()[:6]
    stroke = max(2, min(w, h) // 90)
    r = max(8, min(w, h) // 6)
    title = max(16, min(w, h) // 12)
    sub = max(10, min(w, h) // 24)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}">'
        f'<rect width="100%" height="100%" fill="#f4efe6"/>'
        f'<rect x="{stroke}" y="{stroke}" width="{w - 2 * stroke}" '
        f'height="{h - 2 * stroke}" fill="none" stroke="#6E1F2B" '
        f'stroke-width="{stroke}"/>'
        f'<circle cx="{w // 2}" cy="{int(h * 0.40)}" r="{r}" fill="#{h8}" '
        f'opacity="0.45"/>'
        f'<text x="50%" y="56%" font-family="Georgia,serif" font-size="{title}" '
        f'fill="#16130f" text-anchor="middle">OpenVisual</text>'
        f'<text x="50%" y="64%" font-family="monospace" font-size="{sub}" '
        f'fill="#6E1F2B" text-anchor="middle">{w}×{h} · mock</text>'
        f"</svg>"
    )
    b64 = base64.b64encode(svg.encode("utf-8")).decode()
    return f"data:image/svg+xml;base64,{b64}"


class MockImageProvider(ImageProvider):
    async def generate(
        self,
        prompt: str,
        *,
        width: int,
        height: int,
        n: int,
        negative: list[str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> list[str]:
        # `negative` / `extra` are intentionally ignored for URL generation —
        # the seam between "constraint compiled by web" and "constraint
        # echoed in params" is asserted at the /v1/generate response layer,
        # not at the placeholder URL.
        return [
            _placeholder(f"{prompt}-{i}", width, height) for i in range(n)
        ]

    async def edit(
        self, image_url: str, op: str, payload: dict[str, Any]
    ) -> str:
        return _placeholder(f"{image_url}-{op}", 1024, 1024)

    async def check(self) -> ProviderCheck:
        return ProviderCheck(True, _MOCK_CHECK_DETAIL)


class MockVLMProvider(VLMProvider):
    async def analyze_assets(
        self, assets: list[dict[str, str]]
    ) -> dict[str, Any]:
        ev = (
            [{"assetId": assets[0]["id"], "note": "mock evidence"}]
            if assets
            else []
        )
        return {
            "rules": [
                {
                    "type": "color",
                    "strength": "STRONG",
                    "summary": "主色 #16130f，辅助色 #b9986a，奶油底 #f4efe6",
                    "value": {"palette": _PALETTE},
                    "evidence": ev,
                },
                {
                    "type": "font",
                    "strength": "WEAK",
                    "summary": "标题衬线，正文无衬线，强对比层级",
                    "value": {"display": "serif", "body": "sans"},
                    "evidence": ev,
                },
                {
                    "type": "layout",
                    "strength": "WEAK",
                    "summary": "大留白、左对齐标题、产品居中、CTA 右下",
                    "value": {"grid": "editorial"},
                    "evidence": ev,
                },
                {
                    "type": "imagery",
                    "strength": "STRONG",
                    "summary": "暖光、近景、浅景深、真实场景质感",
                    "value": {"lighting": "warm", "depth": "shallow"},
                    "evidence": ev,
                },
                {
                    "type": "copy",
                    "strength": "FORBIDDEN",
                    "summary": "禁用绝对化与功效承诺表达",
                    "value": {"tone": "克制、质感"},
                    "evidence": ev,
                },
            ],
            "colorSystem": {
                "palette": _PALETTE,
                "pairing": [["#16130f", "#f4efe6"], ["#b9986a", "#16130f"]],
                "restrictions": ["禁止高饱和荧光色", "Logo 不可置于低对比背景"],
                "contrastScore": 92,
                "consistencyScore": 91,
            },
        }

    async def parse_manual(
        self, text: str, pages: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        # Evidence carries no assetId — the web worker stamps the VI_DOC asset
        # id onto each rule, mirroring the image-recognition path's evidence.
        return {
            "rules": [
                {
                    "type": "color",
                    "strength": "STRONG",
                    "summary": "手册规定主色 #16130f、辅助色 #b9986a、奶油底 #f4efe6",
                    "value": {"palette": _PALETTE},
                    "evidence": [],
                },
                {
                    "type": "font",
                    "strength": "STRONG",
                    "summary": "标题使用衬线字体，正文无衬线，禁止随意替换字族",
                    "value": {"display": "serif", "body": "sans"},
                    "evidence": [],
                },
                {
                    "type": "layout",
                    "strength": "WEAK",
                    "summary": "Logo 安全留白不小于字高，统一网格与对齐",
                    "value": {"grid": "editorial", "clearSpace": "1x"},
                    "evidence": [],
                },
                {
                    "type": "copy",
                    "strength": "FORBIDDEN",
                    "summary": "禁用绝对化与功效承诺等违规表达",
                    "value": {"tone": "克制、质感"},
                    "evidence": [],
                },
            ],
            "colorSystem": {
                "palette": _PALETTE,
                "pairing": [["#16130f", "#f4efe6"], ["#b9986a", "#16130f"]],
                "restrictions": ["禁止高饱和荧光色", "Logo 不可置于低对比背景"],
                "contrastScore": 90,
                "consistencyScore": 93,
            },
        }

    async def check_visual_compliance(
        self,
        image_url: str,
        brand_rules: list[dict[str, Any]],
        references: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        # `references` (D5 example assets) are ignored by the deterministic mock
        # — the wiring is asserted at the request/contract layer, not the score.
        return {
            "results": [
                {
                    "level": "PASS",
                    "reason": "Logo 存在且清晰",
                    "category": "BRAND_VISUAL",
                },
                {
                    "level": "PASS",
                    "reason": "主色与品牌色板一致",
                    "category": "BRAND_VISUAL",
                },
            ],
            "score": 88,
        }

    async def describe_asset(
        self,
        url: str,
        *,
        category: str | None = None,
        brand_tone: str | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        # Deterministic, zero-key tags. The category hint (when given) leads the
        # tag list so the wiring (category → request → response) is observable.
        tags = ["产品图", "暖色调", "浅景深", "真实场景"]
        if category:
            tags = [str(category), *tags]
        return {
            "aiTags": tags,
            "aiDescription": (
                "暖光近景的品牌素材，浅景深、真实场景质感，适合电商主图与社媒投放。"
            ),
        }

    async def summarize(
        self, mode: str, text: str, *, context: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        # Deterministic, zero-key result. The input `text` leads the output so
        # the wiring (text → request → response) is observable end-to-end, and
        # no field is null (the no-null contract holds via the defaults).
        snippet = (text or "").strip().splitlines()[0][:60] if text else ""
        if mode == "brief_decompose":
            return {
                "sellingPoint": snippet or "核心卖点",
                "scene": "自然光生活场景",
                "sceneType": "SOCIAL_POSTER",
                "styleKeywords": ["清透", "高级感", "暖色调"],
                "summary": (f"已从需求拆解：{snippet}" if snippet else "已拆解需求"),
            }
        # campaign_summary
        return {
            "summary": (
                f"项目当前进展概述：{snippet}。建议下一步在工作台围绕核心卖点出图，"
                "并在品牌知识库确认色彩与调性规则后批量产出多渠道素材。"
                if snippet
                else "项目摘要：建议进入工作台出图并确认品牌规则。"
            ),
            "highlights": ["明确核心卖点", "确认品牌色彩与调性", "规划多渠道出图"],
        }

    async def scrape_website(self, url: str) -> dict[str, Any]:
        return {
            "images": [
                {
                    "sourceUrl": f"{url}/logo.png",
                    "previewUrl": _placeholder("logo", 240, 240),
                    "guessedCategory": "LOGO",
                },
                {
                    "sourceUrl": f"{url}/hero.jpg",
                    "previewUrl": _placeholder("hero", 480, 270),
                    "guessedCategory": "KV",
                },
                {
                    "sourceUrl": f"{url}/product.jpg",
                    "previewUrl": _placeholder("product", 320, 320),
                    "guessedCategory": "PRODUCT",
                },
            ],
            "copies": ["每一杯都值得慢下来", "源自高海拔单一产区"],
            "sellingPoints": ["手工冷萃", "低温慢萃 18 小时", "无添加"],
            "siteStyle": {
                "palette": _PALETTE,
                "fonts": ["Source Han Serif", "Inter"],
                "themeColor": "#16130f",
                "logoUrl": _placeholder("logo", 240, 240),
                "siteName": "OpenVisual Demo",
            },
        }

    async def check(self) -> ProviderCheck:
        return ProviderCheck(True, _MOCK_CHECK_DETAIL)


class MockLayerProvider(LayerProvider):
    """Deterministic layer decomposition — real RGBA PNGs, zero keys.

    Unlike the SVG placeholders above this emits actual raster layers, because
    the two hardest predicates in this feature are pixel predicates and they
    must be runnable with no upstream:

    * **composite restores the source** — alpha-compositing the whole set must
      reproduce the flattened image. One predicate catches dropped layers,
      reversed order, eaten alpha and over-cropping at once.
    * **a thin layer is not an empty layer** — the last layer is deliberately a
      2px outline (ink coverage well under 1%), mirroring the real upstream's
      thin accent layer. Anything that treats low coverage as "empty" and
      hides it by default goes red here.
    """

    CANVAS = 512
    _BG = (24, 22, 34, 255)
    _FILLS = [
        (124, 92, 255, 255),
        (92, 200, 150, 255),
        (224, 168, 60, 255),
        (240, 133, 122, 255),
        (110, 170, 240, 255),
        (200, 120, 200, 255),
        (140, 210, 110, 255),
        (250, 210, 90, 255),
    ]

    @staticmethod
    def _png_data_url(img: "Image.Image") -> str:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    async def decompose(
        self,
        image_url: str,
        *,
        layer_count: int,
        intent: str | None = None,
    ) -> dict[str, Any]:
        n = clamp_layer_count(layer_count)
        size = self.CANVAS
        layers: list[dict[str, Any]] = []

        base = Image.new("RGBA", (size, size), self._BG)
        layers.append(
            {"imageUrl": self._png_data_url(base), "width": size, "height": size}
        )

        # Middle layers: solid blocks on transparency, laid out on a diagonal so
        # every layer has a distinct bounding box (a set of identical boxes
        # would let a "did it really split?" assertion pass for free).
        for i in range(1, n):
            layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            draw = ImageDraw.Draw(layer)
            if i == n - 1 and n >= 3:
                # Thin accent layer — viewfinder corner brackets, mirroring the
                # real upstream's thinnest layer (measured 0.12% ink). Roughly
                # 0.17% here: comfortably under the thin marker line and just as
                # comfortably above zero, so "thin" and "empty" stay distinct.
                inset, seg, w = 40, 28, 2
                lo, hi = inset, size - inset
                accent = (120, 255, 90, 255)
                def _bar(x0: int, y0: int, x1: int, y1: int) -> None:
                    draw.rectangle(
                        [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)],
                        fill=accent,
                    )

                for cx, cy, dx, dy in (
                    (lo, lo, 1, 1),
                    (hi, lo, -1, 1),
                    (lo, hi, 1, -1),
                    (hi, hi, -1, -1),
                ):
                    _bar(cx, cy, cx + dx * seg, cy + dy * w)  # horizontal arm
                    _bar(cx, cy, cx + dx * w, cy + dy * seg)  # vertical arm
            else:
                fill = self._FILLS[(i - 1) % len(self._FILLS)]
                step = max(24, size // (n + 2))
                x0 = 32 + (i - 1) * step
                y0 = 48 + (i - 1) * step
                draw.rectangle(
                    [x0, y0, min(x0 + 160, size - 8), min(y0 + 120, size - 8)],
                    fill=fill,
                )
            layers.append(
                {"imageUrl": self._png_data_url(layer), "width": size, "height": size}
            )

        # Stable, input-derived seed: the same image + count + intent reproduces
        # the same split, which is exactly what the real seed is for.
        digest = hashlib.sha1(
            f"{image_url}|{n}|{(intent or '').strip()}".encode()
        ).hexdigest()[:8]
        return {"layers": layers, "seed": int(digest, 16), "model": "mock-layer"}

    async def check(self) -> ProviderCheck:
        return ProviderCheck(True, _MOCK_CHECK_DETAIL)
