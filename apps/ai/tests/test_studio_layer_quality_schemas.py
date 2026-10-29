"""Pixel triage contract tests. No provider calls or image-quality claims."""
import pytest
from pydantic import ValidationError
from app.studio_layer_quality_schemas import StudioLayerQualityReport
from app.studio_decomposition_schemas import StudioDecompositionView
from tests.test_studio_decomposition_schemas import receipt


def quality():
    return dict(revision="layer-quality-r1", status="COMPOSITE_MATCH", sourceSha256="a" * 64,
                sourceWidth=120, sourceHeight=80, sampleWidth=120, sampleHeight=80,
                metrics=dict(meanAbsoluteError=0, changedPixelRatio=0, alphaMeanAbsoluteError=0), regions=[],
                thresholds=dict(changedChannelDelta=24, meanAbsoluteError=8, changedPixelRatio=0.05,
                                alphaMeanAbsoluteError=8, regionChangedPixelRatio=0.1),
                warnings=[], unavailableReason=None, semanticsChecked=False, textChecked=False,
                humanReviewRequired=True, checkedAt="2026-10-29T03:00:00Z")


def test_quality_is_pixel_triage_only_and_old_receipts_default_to_unchecked():
    assert StudioLayerQualityReport.model_validate(quality()).humanReviewRequired
    assert StudioDecompositionView.model_validate(receipt("SUCCEEDED")).quality is None
    assert StudioDecompositionView.model_validate(receipt("SUCCEEDED") | dict(quality=quality())).quality.status == "COMPOSITE_MATCH"


def test_unavailable_has_a_reason_and_no_fabricated_measurements():
    value = quality() | dict(status="UNAVAILABLE", unavailableReason="SOURCE_MISMATCH", metrics=None,
                             sampleWidth=None, sampleHeight=None, warnings=["QUALITY_CHECK_UNAVAILABLE"])
    assert StudioLayerQualityReport.model_validate(value).metrics is None
    with pytest.raises(ValidationError): StudioLayerQualityReport.model_validate(value | dict(sampleWidth=120))
    with pytest.raises(ValidationError): StudioLayerQualityReport.model_validate(value | dict(unavailableReason=None))


@pytest.mark.parametrize("change", [
    dict(status="PASSED"), dict(revision="layer-quality-r2"), dict(semanticsChecked=True), dict(textChecked=True),
    dict(humanReviewRequired=False), dict(sourceUrl="https://private.invalid"), dict(sampleWidth=1025),
    dict(sampleWidth=121), dict(sampleWidth=None), dict(unavailableReason="CHECK_FAILED"),
    dict(metrics=dict(meanAbsoluteError=float("nan"), changedPixelRatio=0, alphaMeanAbsoluteError=0)),
    dict(metrics=dict(meanAbsoluteError=0, changedPixelRatio=1.1, alphaMeanAbsoluteError=0)),
    dict(metrics=dict(meanAbsoluteError=255, changedPixelRatio=1, alphaMeanAbsoluteError=255)),
    dict(warnings=["COMPOSITE_DIFFERENCE"]), dict(status="REVIEW_REQUIRED"),
    dict(regions=[dict(left=119, top=0, width=2, height=1, changedPixelRatio=1)]),
    dict(warnings=["TEXT_VERIFIED"]), dict(checkedAt="2026-02-29T03:00:00Z"),
])
def test_rejects_claims_outside_the_bounded_versioned_pixel_report(change):
    with pytest.raises(ValidationError): StudioLayerQualityReport.model_validate(quality() | change)


def test_quality_cannot_be_attached_to_another_source_or_unpublished_task():
    value = quality()
    with pytest.raises(ValidationError): StudioDecompositionView.model_validate(receipt() | dict(quality=value))
    for change in [dict(sourceSha256="b" * 64), dict(sourceWidth=121)]:
        with pytest.raises(ValidationError): StudioDecompositionView.model_validate(receipt("SUCCEEDED") | dict(quality=value | change))


def test_requested_layer_count_mirrors_optional_not_nullable_wire_rule():
    assert StudioDecompositionView.model_validate(receipt() | dict(requestedLayerCount=2)).requestedLayerCount == 2
    for change in [dict(requestedLayerCount=None), dict(requestedLayerCount=3)]:
        with pytest.raises(ValidationError): StudioDecompositionView.model_validate(receipt() | change)
