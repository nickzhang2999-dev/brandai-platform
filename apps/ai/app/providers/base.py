"""Provider adapter contracts. Business code depends only on these ABCs."""
from abc import ABC, abstractmethod
from typing import Any


class ProviderCheck:
    """Result of a cheap reachability/auth self-check. `ok` plus a short,
    operator-readable `detail` (status + body snippet, or exception name)."""

    def __init__(self, ok: bool, detail: str):
        self.ok = ok
        self.detail = detail


class ImageProvider(ABC):
    @abstractmethod
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
        """Return n image URLs.

        P1.2 additive args: `negative` (joined into the provider's
        ``negative_prompt`` field where supported) and `extra` (machine-rule
        knobs such as ``aspect_ratio`` / ``cfg`` / ``seed``). Both default
        ``None`` so pre-P1.2 callers and provider impls stay binary-compatible.
        """

    @abstractmethod
    async def edit(
        self, image_url: str, op: str, payload: dict[str, Any]
    ) -> str:
        """Return edited image URL."""

    @abstractmethod
    async def check(self) -> "ProviderCheck":
        """Cheap auth + reachability probe (never raises). See ProviderCheck."""


class VLMProvider(ABC):
    @abstractmethod
    async def analyze_assets(
        self, assets: list[dict[str, str]]
    ) -> dict[str, Any]:
        """Return recognized brand rules + color system."""

    @abstractmethod
    async def parse_manual(
        self, text: str, pages: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        """Return rules, color system and visual crops from a brand manual.

        ``pages`` contains rendered PDF-page images plus page-local text. It is
        optional so text-only callers and deterministic mocks stay compatible.
        """

    @abstractmethod
    async def check_visual_compliance(
        self,
        image_url: str,
        brand_rules: list[dict[str, Any]],
        references: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Return ``{"results": [...], "score": int|None}``.

        ``results`` is the categorical PASS/RISK/FORBIDDEN list; ``score`` is a
        0–100 brand-consistency score for the whole image (``None`` when the
        model omits it or no image was inspected).

        D5 additive arg: ``references`` is the list of positive/negative example
        assets (``{url, polarity, source, note?}``) to compare the image
        against. ``None`` keeps the pre-D5 behaviour.
        """

    @abstractmethod
    async def describe_asset(
        self,
        url: str,
        *,
        category: str | None = None,
        brand_tone: str | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        """E9/E10 — auto-tag one image asset.

        Return ``{"aiTags": [str, ...], "aiDescription": str}``. ``category`` /
        ``brand_tone`` are optional steering hints; ``source`` is the SSRF
        provenance hint (see ``_inline_image``)."""

    @abstractmethod
    async def summarize(
        self, mode: str, text: str, *, context: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """B2/C8 — text-only chat over a brand brief / campaign context.

        ``mode`` is ``"brief_decompose"`` (return ``sellingPoint`` / ``scene`` /
        ``sceneType`` / ``styleKeywords`` / ``summary``) or ``"campaign_summary"``
        (return ``summary`` / ``highlights``). ``context`` carries optional
        steering (brand tone, confirmed rule summaries, names). Returns a dict in
        the SummarizeResponse shape; omitted keys degrade to the contract default
        (no nulls)."""

    @abstractmethod
    async def scrape_website(self, url: str) -> dict[str, Any]:
        """Return images / copies / selling points from a site."""

    @abstractmethod
    async def check(self) -> "ProviderCheck":
        """Cheap auth + reachability probe (never raises). See ProviderCheck."""
