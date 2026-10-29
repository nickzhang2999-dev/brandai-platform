import pytest
from pydantic import ValidationError
from app.inspiration_schemas import InspirationFeedbackInput, InspirationFeedbackUpdate


@pytest.mark.parametrize('kind', ['IRRELEVANT', 'ANALYSIS_ERROR', 'UNSUPPORTED_CITATION', 'BROKEN_IMAGE'])
def test_feedback_kinds_and_whitespace(kind):
    assert InspirationFeedbackInput(caseId='case-a', revision=1, kind=kind, note=' 说明 ').note == '说明'


@pytest.mark.parametrize('extra', [{'note': 'x' * 1001}, {'userId': 'other'}, {'status': 'RESOLVED'}, {'note': None}])
def test_feedback_rejects_unbounded_or_client_owned_fields(extra):
    with pytest.raises(ValidationError):
        InspirationFeedbackInput.model_validate(dict(caseId='case-a', revision=1, kind='IRRELEVANT', **extra))


def test_review_only_changes_status():
    assert InspirationFeedbackUpdate(status='RESOLVED').status == 'RESOLVED'
    with pytest.raises(ValidationError):
        InspirationFeedbackUpdate(status='RESOLVED', note='overwrite')
