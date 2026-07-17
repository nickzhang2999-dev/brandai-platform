"""Deterministic mock provider — lets the whole P0 loop run with no API keys."""
import base64
import hashlib
from typing import Any

from .base import ImageProvider, ProviderCheck, VLMProvider

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
