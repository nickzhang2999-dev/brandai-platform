"""AUTHORITATIVE REGRESSION GUARD.

The original production bug: FastAPI emitted explicit `null` for unset
optional fields; the shared Zod contracts use `.optional()` (which rejects
null), so M2 recognize-worker and M5 precheck silently failed at the
contract boundary.

These tests assert the invariant that fixed it: NO response from ANY AI
endpoint may contain a null anywhere in its body. If someone removes
`response_model_exclude_none=True`, this suite goes red immediately.
"""
import pytest

from .conftest import find_nulls

ENDPOINTS = [
    ("/v1/ingest/website", {"url": "https://example.com"}),
    ("/v1/recognize", {"assets": [{"id": "a1", "url": "http://x/y.png"}]}),
    ("/v1/describe", {"url": "http://x/y.png", "category": "PRODUCT"}),
    (
        "/v1/summarize",
        {"mode": "brief_decompose", "text": "为夏季新品做一组小红书种草主视觉"},
    ),
    (
        "/v1/summarize",
        {
            "mode": "campaign_summary",
            "text": "夏季新品上市 Campaign，已完成 KV 初稿",
            "context": {"ruleSummaries": ["主色 #7C5CFF", "标题衬线"]},
        },
    ),
    (
        "/v1/generate",
        {
            "sceneType": "ECOM_MAIN",
            "sellingPoint": "手工冷萃",
            "scene": "门店暖光",
            "brandRules": [],
            "versionCount": 3,
        },
    ),
    (
        "/v1/edit",
        {"imageUrl": "http://x/y.png", "op": "RESIZE",
         "payload": {"width": 1080, "height": 1350}},
    ),
    (
        "/v1/compliance/check",
        {"text": "全网第一", "imageUrl": "http://x/y.png",
         "brandRules": [], "termLib": []},
    ),
]


def test_null_detector_actually_catches_a_planted_null():
    """Trust-but-verify the guard itself — assume it could be vacuous.

    A guard that never fails is worthless, so prove it fails on a known
    bad shape before trusting its green on real responses.
    """
    bad = {"ok": "x", "evidence": [{"assetId": "a", "bbox": None}]}
    hits = find_nulls(bad)
    assert hits == ["$.evidence[0].bbox"], hits


@pytest.mark.parametrize("path,body", ENDPOINTS, ids=[e[0] for e in ENDPOINTS])
def test_endpoint_response_has_no_nulls(client, path, body):
    res = client.post(path, json=body)
    assert res.status_code == 200, res.text
    hits = find_nulls(res.json())
    assert hits == [], (
        f"{path} returned null(s) at {hits} — this breaks the Zod "
        f".optional() contract boundary. Keep response_model_exclude_none=True."
    )
