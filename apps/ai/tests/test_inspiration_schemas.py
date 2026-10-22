import pytest
from pydantic import ValidationError
from app.inspiration_schemas import InspirationChatInput, InspirationBookmarkInput


def test_chat_request_identity_and_trim():
    value = InspirationChatInput(requestId='c78bfd95-d837-47de-a13c-aae41b32ea3f', question='  包装案例  ')
    assert value.question == '包装案例'


@pytest.mark.parametrize('field', ['conversationId', 'caseIds'])
def test_optional_input_null_is_rejected(field):
    with pytest.raises(ValidationError):
        InspirationChatInput(**{'requestId': 'c78bfd95-d837-47de-a13c-aae41b32ea3f', 'question': '问题', field: None})


def test_chat_requires_bounded_valid_case_ids():
    with pytest.raises(ValidationError):
        InspirationChatInput(requestId='c78bfd95-d837-47de-a13c-aae41b32ea3f', question='问题', caseIds=['../escape'])


def test_bookmark_requires_revision_and_scoped_project_shape():
    with pytest.raises(ValidationError):
        InspirationBookmarkInput(caseId='case-1', revision=0)
    with pytest.raises(ValidationError):
        InspirationBookmarkInput(caseId='case-1', revision=1, projectId=None)
    assert InspirationBookmarkInput(caseId='case-1', revision=1, note='  借鉴  ').note == '借鉴'
