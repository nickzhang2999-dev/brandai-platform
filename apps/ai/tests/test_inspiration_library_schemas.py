import pytest
from pydantic import ValidationError
from app.inspiration_schemas import (
    InspirationBookmarkInput, InspirationCaseCard, InspirationChatInput,
    InspirationChatState, InspirationFeedbackInput, InspirationListResponse,
    InspirationReceiveStatus, InspirationSelectedImage, InspirationSourceLibrary,
    InspirationLibraryCreateInput, InspirationLibraryCreateResult,
)

LIBRARY = {'id': 'deepflare-company-inspiration', 'kind': 'SHARED'}
REQUEST = 'c78bfd95-d837-47de-a13c-aae41b32ea3f'
IMAGE = {'caseId': 'same-case', 'imageId': 'image-1', 'revision': 1}


def test_admin_library_creation_input_is_explicit_bounded_and_strict():
    value = {'libraryId': LIBRARY['id'], 'ownerId': 'synthetic-owner'}
    assert InspirationLibraryCreateInput(**value).model_dump(exclude_unset=True) == value
    assert InspirationLibraryCreateInput(**value, workspaceId='selected-brand').workspaceId == 'selected-brand'
    for invalid_workspace in ['', None, 'a' * 129]:
        with pytest.raises(ValidationError):
            InspirationLibraryCreateInput(**value, workspaceId=invalid_workspace)
    for invalid in [{'ownerId': ''}, {'ownerId': None}, {'ownerId': 'a' * 129}, {'libraryId': '../escape'}, {'kind': 'SHARED'}, {'created': True}]:
        with pytest.raises(ValidationError):
            InspirationLibraryCreateInput(**{**value, **invalid})
    with pytest.raises(ValidationError):
        InspirationLibraryCreateInput(libraryId=LIBRARY['id'])


def test_admin_library_creation_result_reports_identity_not_owner_details():
    for created in [True, False]:
        assert InspirationLibraryCreateResult(sourceLibrary=LIBRARY, created=created).model_dump() == {'sourceLibrary': LIBRARY, 'created': created}
    for invalid in [{'sourceLibrary': None, 'created': True}, {'sourceLibrary': LIBRARY}, {'sourceLibrary': LIBRARY, 'created': 'true'}]:
        with pytest.raises(ValidationError):
            InspirationLibraryCreateResult(**invalid)
    assert 'ownerId' not in InspirationLibraryCreateResult(sourceLibrary=LIBRARY, created=False, ownerId='synthetic-owner').model_dump()


def test_shared_and_historical_library_kinds():
    assert InspirationSourceLibrary(**LIBRARY).kind == 'SHARED'
    assert InspirationSourceLibrary(**{**LIBRARY, 'kind': 'WORKSPACE'}).kind == 'WORKSPACE'
    for invalid in [{'id': value} for value in ['', '../other', '/library', 'a?b']] + [{'kind': 'PUBLIC'}]:
        with pytest.raises(ValidationError):
            InspirationSourceLibrary(**{**LIBRARY, **invalid})


@pytest.mark.parametrize('schema,payload', [
    (InspirationChatInput, {'requestId': REQUEST, 'question': 'Synthetic question', 'selectedImages': [{**IMAGE, 'libraryId': LIBRARY['id']}]}),
    (InspirationBookmarkInput, {'caseId': IMAGE['caseId'], 'revision': 1, 'projectId': 'destination-project'}),
    (InspirationFeedbackInput, {'caseId': IMAGE['caseId'], 'revision': 1, 'kind': 'IRRELEVANT'}),
    (InspirationSelectedImage, IMAGE),
    (InspirationCaseCard, {'caseId': 'same-case', 'revision': 1, 'title': 'Synthetic', 'summary': '', 'brandOrTeam': '', 'analysisAllowed': True, 'tags': {}, 'images': [], 'sources': [], 'claims': []}),
])
def test_pin_optional_library_identity_without_allowing_null_or_paths(schema, payload):
    assert schema(**payload).libraryId is None
    assert schema(**payload, libraryId=LIBRARY['id']).libraryId == LIBRARY['id']
    for invalid in [None, '../escape', '']:
        with pytest.raises(ValidationError):
            schema(**payload, libraryId=invalid)


def test_status_list_and_history_keep_their_source_identity():
    status = dict(enabled=True, configured=True, mode='manual', canReceive=False, task=None)
    assert InspirationReceiveStatus(**status).sourceLibrary is None
    assert InspirationReceiveStatus(**status, sourceLibrary=LIBRARY, canReceiveReason='请联系公司灵感库管理员。').sourceLibrary.id == LIBRARY['id']
    assert InspirationReceiveStatus(**status, sourceLibrary=None, canReceiveReason=None).sourceLibrary is None
    listing = dict(enabled=True, syncConfigured=True, activeRelease=None, caseCount=0, withdrawalSequence=0, lastSyncAt=None, error=None, cases=[], searchMode='keyword-tags')
    assert InspirationListResponse(**listing, sourceLibrary=LIBRARY).sourceLibrary.id == LIBRARY['id']
    chat = dict(id='chat-1', conversationId=REQUEST, status='SUCCEEDED', question='', answer='', citations=[], error=None, createdAt='')
    assert InspirationChatState(**chat, sourceLibrary={**LIBRARY, 'kind': 'WORKSPACE'}).sourceLibrary.kind == 'WORKSPACE'
