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
