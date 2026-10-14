import pytest
from pydantic import ValidationError
from app.studio_conversation_model import ConversationModelRequest, ConversationModelDecision, run_conversation_model

def request(**extra):
    return ConversationModelRequest.model_validate({"schemaVersion": 1, "text": "改图片2参考图片1", "references": [
        {"referenceId": "one", "name": "图片1", "editable": True}, {"referenceId": "two", "name": "图片2", "editable": True}],
        "quickEditTargetId": None, "previousResultReferenceId": None, **extra})
def decision(**extra):
    return {"action": "modify", "targetReferenceId": "two", "referenceIds": ["one"], "confidence": .9, "clarification": None, **extra}

@pytest.mark.asyncio
async def test_single_structured_text_call_and_no_urls():
    class Provider:
        calls = 0
        async def _chat_json(self, content, *, system, max_tokens):
            self.calls += 1
            assert "image_url" not in str(content)
            assert "providerRetryPolicy" not in content[0]["text"]
            assert max_tokens == 1200
            return decision()
    provider = Provider()
    result = await run_conversation_model(request(), provider)
    assert result.decision.targetReferenceId == "two"
    assert provider.calls == 1

@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [{"targetReferenceId": "foreign"}, {"referenceIds": ["foreign"]}, {"referenceIds": ["two"]}])
async def test_untrusted_output_is_rejected_without_retry(extra):
    class Provider:
        calls = 0
        async def _chat_json(self, *args, **kwargs):
            self.calls += 1
            return decision(**extra)
    provider = Provider()
    with pytest.raises(ValueError):
        await run_conversation_model(request(), provider)
    assert provider.calls == 1

@pytest.mark.asyncio
async def test_pinned_target_cannot_change_and_unknown_error_never_retries():
    class Provider:
        calls = 0
        async def _chat_json(self, *args, **kwargs):
            self.calls += 1
            return decision()
    provider = Provider()
    with pytest.raises(ValueError):
        await run_conversation_model(request(quickEditTargetId="one"), provider)
    assert provider.calls == 1
    class Unknown:
        calls = 0
        async def _chat_json(self, *args, **kwargs):
            self.calls += 1
            raise TimeoutError("unknown response")
    unknown = Unknown()
    with pytest.raises(TimeoutError):
        await run_conversation_model(request(), unknown)
    assert unknown.calls == 1

def test_contract_invalid_actions_and_retry_policy():
    with pytest.raises(ValidationError):
        request(providerRetryPolicy="auto")
    with pytest.raises(ValidationError):
        ConversationModelDecision.model_validate(decision(action="generate"))
