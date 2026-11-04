"""Local synthetic fixtures prove evidence logic, not model capability."""
import asyncio
import base64
import copy
import hashlib
import io
import pytest
from PIL import Image
from pydantic import ValidationError
from app.visual_fidelity import aggregate_fidelity, image_sha256
from app.visual_fidelity_schemas import VisualFidelityPlan
from app.schemas import ComplianceCheckRequest
from app.providers.http_providers import HttpVLMProvider

INPUT = "a" * 64
OUTPUT = "b" * 64
PLAN = {"revision": "visual-fidelity-guard/1", "inputSha256": INPUT, "constraints": [
    {"id": "apple", "target": "left apple", "attribute": "colour", "expected": "green skin", "strength": "hard", "source": "user"},
    {"id": "background", "target": "background", "attribute": "colour", "expected": "red", "strength": "hard", "source": "brand"},
]}

def row(id, status="pass"):
    return {"id": id, "status": status, "objectRegion": "left foreground apple" if id == "apple" else "background behind apple", "observation": "visible surface colour", "evidence": "local visible colour matches the specified object attribute"}

def raw(rows=None):
    return {"inputSha256": INPUT, "outputSha256": OUTPUT, "checks": rows if rows is not None else [row("apple"), row("background")]}

def report(data=None, **kwargs):
    return aggregate_fidelity(PLAN, OUTPUT, data if data is not None else raw(), output_read=True, **kwargs)

def test_pass_and_fail_are_based_on_complete_hard_inventory():
    assert report()["overall"] == "pass"
    assert report(raw([row("apple", "fail"), row("background")]))["overall"] == "fail"
    assert report(raw([row("apple", "fail")]))["overall"] == "fail"

@pytest.mark.parametrize("rows", [[], [row("apple")], [row("apple"), row("apple", "fail"), row("background")], [row("apple"), row("background"), row("invented")]])
def test_missing_duplicate_and_unknown_ids_cannot_pass(rows):
    assert report(raw(rows))["overall"] == "unknown"

@pytest.mark.parametrize("field", ["inputSha256", "outputSha256"])
def test_stale_bindings_cannot_pass(field):
    data = raw(); data[field] = "c" * 64
    result = report(data)
    assert result["overall"] == "unknown"
    assert result["checkPerformed"] is False

def test_unread_output_and_missing_source_cannot_pass():
    assert aggregate_fidelity(PLAN, OUTPUT, raw())["overall"] == "unknown"
    assert report(sources_complete=False)["overall"] == "unknown"

def test_whole_image_palette_and_unlocalized_claims_cannot_prove_subject():
    data = raw(); data["checks"][0]["evidence"] = "whole-image palette contains green"
    assert report(data)["checks"][0]["status"] == "unknown"
    data = raw(); del data["checks"][0]["objectRegion"]
    assert report(data)["overall"] == "unknown"

def test_soft_failure_warns_without_becoming_hard_failure():
    plan = copy.deepcopy(PLAN); plan["constraints"][0]["strength"] = "soft"
    result = aggregate_fidelity(plan, OUTPUT, raw([row("apple", "fail"), row("background")]), output_read=True)
    assert result["overall"] == "pass"
    assert result["warnings"]

def test_empty_or_only_soft_plan_is_not_applicable():
    plan = copy.deepcopy(PLAN); plan["constraints"] = []
    assert aggregate_fidelity(plan, OUTPUT)["overall"] == "not_applicable"
    plan = copy.deepcopy(PLAN)
    for c in plan["constraints"]: c["strength"] = "soft"
    assert aggregate_fidelity(plan, OUTPUT, raw(), output_read=True)["overall"] == "not_applicable"

def test_contract_rejects_null_duplicate_and_unbound_plan():
    plan = copy.deepcopy(PLAN); plan["constraints"].append(plan["constraints"][0])
    with pytest.raises(ValidationError): VisualFidelityPlan.model_validate(plan)
    with pytest.raises(ValidationError): ComplianceCheckRequest.model_validate({"visualFidelityPlan": PLAN})
    with pytest.raises(ValidationError): ComplianceCheckRequest.model_validate({"visualFidelityPlan": None})

def image_fixture():
    buffer = io.BytesIO(); Image.new("RGB", (2, 2), "green").save(buffer, format="PNG")
    image = buffer.getvalue()
    return "data:image/png;base64," + base64.b64encode(image).decode(), hashlib.sha256(image).hexdigest()

def test_only_decodable_image_bytes_count_as_read():
    data, digest = image_fixture()
    assert image_sha256(data) == digest
    assert image_sha256("https://unread.invalid/image.png") is None
    assert image_sha256("data:image/png;base64,aGVsbG8=") is None

def test_same_model_call_checks_compliance_and_fidelity(monkeypatch):
    data, digest = image_fixture(); calls = []
    provider = HttpVLMProvider("https://never-called.invalid/v1", "synthetic-only")
    async def inline(url, **kwargs): return data
    async def chat(parts, **kwargs):
        calls.append((parts, kwargs))
        judgement = raw(); judgement["outputSha256"] = digest
        return {"results": [], "score": 100, "visualFidelity": judgement}
    monkeypatch.setattr(provider, "_inline_image", inline)
    monkeypatch.setattr(provider, "_chat_json", chat)
    result = asyncio.run(provider.check_visual_compliance("output", [], visual_fidelity_plan=PLAN, output_sha256=digest,
        fidelity_source_images=[{"url": "source", "sha256": digest, "sourceHint": "WEBSITE"}]))
    assert len(calls) == 1
    assert result["visualCheckPerformed"] is True
    assert result["visualFidelityReport"]["overall"] == "pass"
    assert "edit-source" in str(calls[0][0])

def test_output_mismatch_does_not_call_paid_model(monkeypatch):
    data, _ = image_fixture()
    provider = HttpVLMProvider("https://never-called.invalid/v1", "synthetic-only")
    async def inline(url, **kwargs): return data
    async def chat(*args, **kwargs): raise AssertionError("must not call provider")
    monkeypatch.setattr(provider, "_inline_image", inline); monkeypatch.setattr(provider, "_chat_json", chat)
    result = asyncio.run(provider.check_visual_compliance("output", [], visual_fidelity_plan=PLAN, output_sha256=OUTPUT))
    assert result["visualFidelityReport"]["overall"] == "unknown"
    assert result["visualFidelityReport"]["checkPerformed"] is False

def test_mock_provider_cannot_claim_fidelity_check(client):
    result = client.post("/v1/compliance/check", json={"imageUrl": "http://x/a.png", "visualFidelityPlan": PLAN, "outputSha256": OUTPUT, "termLib": []})
    assert result.status_code == 200
    assert result.json()["visualFidelityReport"]["overall"] == "unknown"
    assert result.json()["visualFidelityReport"]["checkPerformed"] is False

@pytest.mark.parametrize("sources", [[], [{"url": "source", "sha256": "d" * 64, "sourceHint": "WEBSITE"}]])
def test_missing_or_wrong_source_is_unknown_even_when_model_claims_pass(monkeypatch, sources):
    data, digest = image_fixture(); calls = []
    provider = HttpVLMProvider("https://never-called.invalid/v1", "synthetic-only")
    plan = copy.deepcopy(PLAN); plan["constraints"][0]["source"] = "source"
    async def inline(url, **kwargs):
        calls.append((url, kwargs))
        return data
    async def chat(parts, **kwargs):
        judgement = raw(); judgement["outputSha256"] = digest
        assert len([part for part in parts if part["type"] == "image_url"]) == 1
        return {"results": [], "score": 100, "visualFidelity": judgement}
    monkeypatch.setattr(provider, "_inline_image", inline); monkeypatch.setattr(provider, "_chat_json", chat)
    result = asyncio.run(provider.check_visual_compliance("output", [], visual_fidelity_plan=plan, output_sha256=digest, fidelity_source_images=sources))
    assert result["visualFidelityReport"]["overall"] == "unknown"
    assert result["visualCheckPerformed"] is True
    if sources: assert calls[-1][1] == {"source": "WEBSITE"}

def test_fidelity_only_model_result_does_not_fake_legacy_compliance_pass(monkeypatch):
    data, digest = image_fixture()
    provider = HttpVLMProvider("https://never-called.invalid/v1", "synthetic-only")
    async def inline(url, **kwargs): return data
    async def chat(parts, **kwargs):
        judgement = raw(); judgement["outputSha256"] = digest
        return {"visualFidelity": judgement}
    monkeypatch.setattr(provider, "_inline_image", inline); monkeypatch.setattr(provider, "_chat_json", chat)
    result = asyncio.run(provider.check_visual_compliance("output", [], visual_fidelity_plan=PLAN, output_sha256=digest))
    assert result["visualCheckPerformed"] is False
    assert result["results"][0]["level"] == "RISK"
    assert result["visualFidelityReport"]["overall"] == "pass"


def test_fixed_unknown_messages_and_model_language_instruction_are_chinese():
    from app.visual_fidelity import FIDELITY_SYSTEM
    result = aggregate_fidelity(PLAN, OUTPUT)
    assert result["warnings"] and all(any("\u4e00" <= char <= "\u9fff" for char in warning) for warning in result["warnings"])
    for check in result["checks"]:
        assert "尚不能确认" in check["observation"]
        assert "尚无有效" in check["evidence"]
    assert "Simplified Chinese" in FIDELITY_SYSTEM
    assert "Preserve constraint IDs" in FIDELITY_SYSTEM


def test_compound_requirements_and_reference_roles_require_complete_evidence():
    from app.visual_fidelity import FIDELITY_SYSTEM
    assert "EVERY subrequirement" in FIDELITY_SYSTEM
    assert "return unknown" in FIDELITY_SYSTEM
    assert "reference-context" in FIDELITY_SYSTEM
    assert "style reference NEVER implies an identity lock" in FIDELITY_SYSTEM


def test_source_metadata_and_generation_revision_mirror_optional_contracts():
    from app.visual_fidelity_schemas import VisualFidelitySourceImage
    from app.schemas import GenerateRequest
    source = VisualFidelitySourceImage.model_validate({"url": "x", "sha256": OUTPUT, "id": "ref", "role": "reference-context", "note": "只借鉴风格"})
    assert source.role == "reference-context"
    with pytest.raises(ValidationError):
        VisualFidelitySourceImage.model_validate({"url": "x", "sha256": OUTPUT, "role": "original-product"})
    base = {"sceneType": "SOCIAL_POSTER", "sellingPoint": "apple", "scene": ""}
    assert "visualFidelityRevision" not in GenerateRequest.model_validate(base).model_dump(exclude_none=True)
    with pytest.raises(ValidationError): GenerateRequest.model_validate({**base, "visualFidelityRevision": None})
