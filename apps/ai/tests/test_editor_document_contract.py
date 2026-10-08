import pytest
from pydantic import ValidationError
from app.schemas import EditorDocumentSaveInput, EditorDocumentView


def test_native_document_wire_contract():
    payload = dict(format="novart-native-v1", canvas="SHAKKERDATA://AAAA", revision=0,
                   mutationId="ad2cb954-07f8-47af-a19f-dfc253364604")
    assert EditorDocumentSaveInput(**payload).model_dump() == payload
    for change in [dict(format="future"), dict(canvas="{}"), dict(revision=True),
                   dict(revision=-1), dict(workspaceId="injected"), dict(mutationId="invalid")]:
        with pytest.raises(ValidationError):
            EditorDocumentSaveInput(**{**payload, **change})


def test_native_document_empty_view_retains_explicit_nulls():
    payload = dict(projectId="p", workspaceId="w", format="novart-native-v1", canvas="",
                   revision=0, checksum=None, updatedAt=None, readOnly=False)
    assert EditorDocumentView(**payload).model_dump() == payload
