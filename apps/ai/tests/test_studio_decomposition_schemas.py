"""Contract-only fixtures. No image model, database, storage or network calls."""
from copy import deepcopy

import pytest
from pydantic import ValidationError

from app.studio_decomposition_schemas import (
    StudioDecompositionInput, StudioDecompositionQuery, StudioDecompositionRetryInput,
    StudioDecompositionLayer, StudioDecompositionView,
)


def intent():
    return dict(projectId="project_1", mutationId="831a0280-2cf1-41ba-ac94-621053c4a4c6",
                sourceShapeId="shape:source", assetId="source_1", assetSha256="a" * 64,
                documentRevision=0, layerCount=2)


def layer(order=0):
    return dict(assetId=f"layer_{order}", assetSha256="b" * 64, mimeType="image/png",
                width=120, height=80, order=order, sizeBytes=100,
                url=f"/api/workspaces/workspace_1/assets/layer_{order}/raw",
                alphaBounds=dict(left=10, top=5, width=20, height=30), inkCoverage=0.1)


def receipt(status="PENDING"):
    return dict(requestId="request_1", **intent(), sourceWidth=120, sourceHeight=80,
                status=status, error=None, createdAt="2026-10-12T03:00:00Z",
                expiresAt="2026-10-12T03:06:00Z", archiveExpiresAt=None,
                canRetryArchive=False, layers=[layer(0), layer(1)] if status == "SUCCEEDED" else [])


def test_input_optional_intent_and_javascript_trim_length():
    assert "intent" not in StudioDecompositionInput.model_validate(intent()).model_dump(exclude_unset=True)
    assert StudioDecompositionInput.model_validate(intent() | dict(intent="\ufeff  split foreground \u3000")).intent == "split foreground"
    assert StudioDecompositionInput.model_validate(intent() | dict(intent=" " * 1000)).intent == ""
    assert len(StudioDecompositionInput.model_validate(intent() | dict(intent="😀" * 250)).intent) == 250
    with pytest.raises(ValidationError):
        StudioDecompositionInput.model_validate(intent() | dict(intent="😀" * 251))


@pytest.mark.parametrize("change", [
    dict(intent=None), dict(intent="x" * 501), dict(projectId="foreign/project"),
    dict(mutationId="same"), dict(sourceShapeId="source"), dict(sourceShapeId="shape:source/other"),
    dict(sourceShapeId="shape:" + "x" * 129), dict(assetId=""), dict(assetSha256="A" * 64),
    dict(documentRevision=-1), dict(documentRevision="0"), dict(documentRevision=True),
    dict(layerCount=1), dict(layerCount=11), dict(layerCount="2"), dict(layerCount=2.5),
    dict(workspaceId="foreign"), dict(userId="foreign"), dict(imageUrl="https://provider.invalid/private"),
])
def test_input_rejects_untrusted_scope_geometry_and_coercion(change):
    with pytest.raises(ValidationError):
        StudioDecompositionInput.model_validate(intent() | change)


def test_history_query_and_explicit_retry_have_distinct_optional_rules():
    assert StudioDecompositionQuery.model_validate(dict(projectId="p")).requestId is None
    assert StudioDecompositionQuery.model_validate(dict(projectId="p", requestId="r")).requestId == "r"
    assert StudioDecompositionRetryInput.model_validate(dict(projectId="p", requestId="r")).requestId == "r"
    for model, value in [
        (StudioDecompositionQuery, dict(projectId="p", requestId=None)),
        (StudioDecompositionQuery, dict(projectId="p", workspaceId="foreign")),
        (StudioDecompositionRetryInput, dict(projectId="p")),
        (StudioDecompositionRetryInput, dict(projectId="p", requestId=None)),
        (StudioDecompositionRetryInput, dict(projectId="p", requestId="r", archiveToken="private")),
    ]:
        with pytest.raises(ValidationError): model.model_validate(value)


@pytest.mark.parametrize("change", [
    dict(alphaBounds=None), dict(alphaBounds=dict(left=101, top=5, width=20, height=30)),
    dict(alphaBounds=dict(left=10, top=51, width=20, height=30)),
    dict(alphaBounds=dict(left=-1, top=5, width=20, height=30)),
    dict(alphaBounds=dict(left=10, top=5, width=0, height=30)),
    dict(alphaBounds=dict(left=10, top=5, width=20, height=30, crop=True)),
    dict(width=16385), dict(height=0), dict(order=-1), dict(order=10),
    dict(sizeBytes=0), dict(sizeBytes=32 * 1024 * 1024 + 1),
    dict(mimeType="image/jpeg"), dict(url="blob:local"), dict(url="https://provider.invalid/private"),
    dict(inkCoverage=-0.1), dict(inkCoverage=1.1), dict(inkCoverage=float("nan")),
    dict(objectKey="private-stage"),
])
def test_layer_requires_public_full_frame_boundaries_and_private_data_stays_out(change):
    with pytest.raises(ValidationError): StudioDecompositionLayer.model_validate(layer() | change)


def test_layer_requires_alpha_bounds_and_accepts_inclusive_limits():
    value = layer()
    del value["alphaBounds"]
    with pytest.raises(ValidationError): StudioDecompositionLayer.model_validate(value)
    assert StudioDecompositionLayer.model_validate(layer() | dict(order=9, sizeBytes=32 * 1024 * 1024)).order == 9


@pytest.mark.parametrize("status", ["PENDING", "RUNNING", "FAILED"])
def test_non_successful_receipts_never_publish_private_layers(status):
    assert StudioDecompositionView.model_validate(receipt(status)).layers == []
    with pytest.raises(ValidationError): StudioDecompositionView.model_validate(receipt(status) | dict(layers=[layer()]))


def test_successful_receipt_requires_order_unique_asset_ids_and_source_sized_layers():
    assert len(StudioDecompositionView.model_validate(receipt("SUCCEEDED")).layers) == 2
    for mutate in [
        lambda value: value.update(layers=[]),
        lambda value: value.update(layers=[layer()]),
        lambda value: value["layers"].reverse(),
        lambda value: value["layers"][1].update(assetId="layer_0"),
        lambda value: value["layers"][1].update(width=60),
        lambda value: value["layers"][1].update(height=40),
    ]:
        value = deepcopy(receipt("SUCCEEDED")); mutate(value)
        with pytest.raises(ValidationError): StudioDecompositionView.model_validate(value)


def test_nullable_receipt_fields_are_required_and_private_keys_are_strict():
    assert StudioDecompositionView.model_validate(receipt()).archiveExpiresAt is None
    for key in ["error", "archiveExpiresAt"]:
        value = receipt(); del value[key]
        with pytest.raises(ValidationError): StudioDecompositionView.model_validate(value)
    for change in [dict(outputJson={}), dict(providerStartedAt=None), dict(objectKeys=[]), dict(canRetryArchive="false"), dict(error="😀" * 501)]:
        with pytest.raises(ValidationError): StudioDecompositionView.model_validate(receipt() | change)


@pytest.mark.parametrize("timestamp", [
    "2026-10-12", "2026-10-12T03:00:00", "2026-10-12T03:00:00+00:00",
    "2026-02-29T03:00:00Z", "2026-10-12T25:00:00Z", "2026-10-12T03:60:00Z",
    "2026-10-12T03:00:00Z\n",
])
def test_receipt_requires_zod_utc_datetime_format(timestamp):
    with pytest.raises(ValidationError): StudioDecompositionView.model_validate(receipt() | dict(createdAt=timestamp))


def test_utc_timestamp_seconds_are_optional_and_fractional_precision_is_not_limited():
    value = receipt() | dict(createdAt="2024-02-29T03:00Z", archiveExpiresAt="2026-10-13T03:00:00.123456789Z")
    assert StudioDecompositionView.model_validate(value).createdAt == "2024-02-29T03:00Z"
