import pytest
from pydantic import ValidationError
from app.schemas import StudioGenerationInput, StudioGenerationQuery, StudioGenerationRetryInput, StudioGenerationView

def body():
    return dict(projectId="p", mutationId="831a0280-2cf1-41ba-ac94-621053c4a4c6", prompt=" tree ", sizeSelection=dict(ratioKey="1:1", resolutionTier="1K"), workflowRevision=0, documentRevision=0)

def test_intent_and_trim():
    assert StudioGenerationInput.model_validate(body()).prompt == "tree"

@pytest.mark.parametrize("change", [dict(userId="foreign"), dict(mutationId="same"), dict(documentRevision="0"), dict(prompt="   "), dict(sizeSelection=dict(ratioKey="1:1",resolutionTier="1K",model="x")), dict(sizeSelection=dict(ratioKey="custom",resolutionTier="1K"))])
def test_bad_intents(change):
    with pytest.raises(ValidationError): StudioGenerationInput.model_validate(body() | change)

def test_history_and_explicit_archive_retry():
    assert StudioGenerationQuery.model_validate(dict(projectId="p")).requestId is None
    assert StudioGenerationRetryInput.model_validate(dict(projectId="p",requestId="r")).requestId == "r"
    for value in [dict(projectId="p"),dict(projectId="p",requestId=None)]:
        with pytest.raises(ValidationError): StudioGenerationRetryInput.model_validate(value)
    with pytest.raises(ValidationError): StudioGenerationQuery.model_validate(dict(projectId="p",requestId=None))

def test_receipt_does_not_imply_public_image_before_archive():
    receipt = dict(requestId="r",mutationId=body()["mutationId"],projectId="p",generationId="g",status="SUCCEEDED",progress=None,expiresAt="2026-10-09T00:06:00Z",archiveExpiresAt="2026-10-10T00:06:00Z",archiveProcessingExpiresAt=None,displayText="tree",resultState="FAILED",results=[],error=None,archiveError="retry archive",canRetryArchive=True)
    assert StudioGenerationView.model_validate(receipt).canRetryArchive
    with pytest.raises(ValidationError): StudioGenerationView.model_validate(receipt | dict(progress=99))
    with pytest.raises(ValidationError): StudioGenerationView.model_validate(receipt | dict(results=[dict(versionId="v",assetId="a",assetSha256="a"*64,width=10,height=20,mimeType="image/png",url="blob:local")]))
