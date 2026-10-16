"""P5 input validation mirrors Zod; zero provider calls are needed."""
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas import AssetRef, DescribeRequest, EditRequest, GenerateRequest, RecognizeRequest, SummarizeRequest


def test_literal_values_match_the_contract_source():
    root = Path(__file__).resolve().parents[3]
    ai = (root / "packages/contracts/src/ai.ts").read_text(encoding="utf-8")
    enums = (root / "packages/contracts/src/enums.ts").read_text(encoding="utf-8")
    def enum_values(source, name):
        match = re.search(rf"export const {name} = z\.enum\(\[(.*?)\]\)", source, re.S)
        assert match, name
        return re.findall(r'"([^"]+)"', match.group(1))
    assert AssetRef.model_json_schema()["properties"]["source"]["anyOf"][0]["enum"] == enum_values(ai, "AssetSourceHint")
    assert DescribeRequest.model_json_schema()["properties"]["source"]["anyOf"][0]["enum"] == enum_values(ai, "AssetSourceHint")
    assert SummarizeRequest.model_json_schema()["properties"]["mode"]["enum"] == enum_values(ai, "SummarizeMode")
    assert EditRequest.model_json_schema()["properties"]["op"]["enum"] == enum_values(enums, "EditOp")
    match = re.search(r'textMode: z\.enum\(\[([^]]+)\]\)\.default\("direct"\)', ai)
    assert match
    assert GenerateRequest.model_json_schema()["properties"]["textMode"]["enum"] == re.findall(r'"([^"]+)"', match.group(1))


@pytest.mark.parametrize("model,base,field", [
    (AssetRef, {"id": "asset", "url": "https://example.invalid/a.png"}, "source"),
    (DescribeRequest, {"url": "https://example.invalid/a.png"}, "source"),
    (SummarizeRequest, {"text": "brief"}, "mode"),
    (GenerateRequest, {"sceneType": "SOCIAL_POSTER", "sellingPoint": "brief", "scene": "scene"}, "textMode"),
    (EditRequest, {"imageUrl": "https://example.invalid/a.png"}, "op"),
])
@pytest.mark.parametrize("invalid", ["unexpected", "", 42, None])
def test_invalid_enum_and_explicit_null_are_rejected(model, base, field, invalid):
    with pytest.raises(ValidationError):
        model.model_validate({**base, field: invalid})


def test_optional_source_remains_omitted_and_text_mode_keeps_default():
    assert "source" not in AssetRef(id="a", url="https://example.invalid/a").model_dump(exclude_none=True)
    assert "source" not in DescribeRequest(url="https://example.invalid/a").model_dump(exclude_none=True)
    assert GenerateRequest(sceneType="SCENE", sellingPoint="brief", scene="scene").textMode == "direct"


def test_recognize_requires_at_least_one_asset():
    with pytest.raises(ValidationError):
        RecognizeRequest(assets=[])
    assert len(RecognizeRequest(assets=[{"id": "a", "url": "https://example.invalid/a", "source": "UPLOAD"}]).assets) == 1


@pytest.mark.parametrize("path,payload", [
    ("/v1/recognize", {"assets": []}),
    ("/v1/recognize", {"assets": [{"id": "a", "url": "https://example.invalid/a", "source": "other"}]}),
    ("/v1/describe", {"url": "https://example.invalid/a", "source": "other"}),
    ("/v1/summarize", {"mode": "other", "text": "brief"}),
    ("/v1/generate", {"sceneType": "SCENE", "sellingPoint": "brief", "scene": "scene", "textMode": "other"}),
    ("/v1/edit", {"imageUrl": "https://example.invalid/a", "op": "other"}),
])
def test_fastapi_rejects_invalid_wire_before_provider_dispatch(client, path, payload):
    assert client.post(path, json=payload).status_code == 422
