import pytest
from pydantic import ValidationError
from app.studio_brand_rule_status_schemas import StudioBrandRuleStatus, StudioBrandRuleReceipt


def test_current_status_preserves_confirmed_and_draft_when_disabled():
    state = dict(workspaceId="w", brandName="Brand", applicationEnabled=False, confirmedCount=3, draftCount=2, savedDraftAvailable=True)
    assert StudioBrandRuleStatus(**state).confirmedCount == 3
    for value in [True, -1, "2", 1.5]:
        with pytest.raises(ValidationError):
            StudioBrandRuleStatus(**{**state, "draftCount": value})


def test_historical_unknown_is_not_zero_and_extra_provider_data_is_rejected():
    data = dict(outputId="o", appliedRuleCount=None, mode=None, reason=None, rules=[], detailsComplete=False, promptAdditionCount=None)
    assert StudioBrandRuleReceipt(**data).appliedRuleCount is None
    assert StudioBrandRuleReceipt(**{**data, "appliedRuleCount": 0, "reason": "IMAGE_TOOL"}).appliedRuleCount == 0
    with pytest.raises(ValidationError):
        StudioBrandRuleReceipt(**{**data, "privateProviderBody": "secret"})


def test_colour_receipt_mirrors_optional_typescript_contract():
    data = dict(outputId="o", appliedRuleCount=1, mode="BRANDED", reason="APPLIED", rules=[], detailsComplete=False, promptAdditionCount=1)
    assert StudioBrandRuleReceipt(**data).colourFidelity is None
    check = dict(checked=True, present=[dict(hex="#7c5cff", share=0.5, closestDetected="#7c5cff", deltaE=0)], missing=[], detected=[dict(hex="#7c5cff", share=0.5)], withinBrand=True)
    parsed = StudioBrandRuleReceipt(**data, colourFidelity=check)
    assert parsed.colourFidelity.neutral == []
    assert parsed.colourFidelity.present[0].share == 0.5
    with pytest.raises(ValidationError):
        StudioBrandRuleReceipt(**data, colourFidelity={**check, "privateProviderBody": "hidden"})
