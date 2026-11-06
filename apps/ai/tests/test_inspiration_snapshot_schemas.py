"""The same synthetic shape vectors are checked by Zod and Pydantic."""
import copy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas import InspirationSnapshotManifest, InspirationSnapshotObjectDescriptor, InspirationSnapshotPartDescriptor

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/protocol-fixtures/inspiration-snapshot-shapes.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["name"])
def test_shared_manifest_shapes(case):
    value = copy.deepcopy(VECTORS["manifest"])
    if "path" in case:
        *segments, leaf = case["path"].split(".")
        target = value
        for segment in segments:
            target = target[segment]
        if case.get("remove"):
            del target[leaf]
        else:
            target[leaf] = case["value"]
    if case["valid"]:
        assert InspirationSnapshotManifest.model_validate(value).model_dump() == value
    else:
        with pytest.raises(ValidationError):
            InspirationSnapshotManifest.model_validate(value)


def test_bounded_descriptors_and_literal_types():
    digest = "a" * 64
    part = dict(prefix="ab", sha256=digest, size=1, records_count=1)
    assert InspirationSnapshotPartDescriptor.model_validate(part)
    for update in [dict(prefix="a"), dict(prefix="abcdefabc"), dict(size=8 * 1024 * 1024 + 1), dict(records_count=2001), dict(path="unexpected")]:
        with pytest.raises(ValidationError):
            InspirationSnapshotPartDescriptor.model_validate(part | update)
    image = dict(path=f"images/{digest}.png", sha256=digest, size=10, mime="image/png", width=1, height=1)
    assert InspirationSnapshotObjectDescriptor.model_validate(image)
    for update in [dict(sha256="b" * 64), dict(mime="image/jpeg"), dict(width=40_000_000, height=2), dict(size=20 * 1024 * 1024 + 1), dict(width=True)]:
        with pytest.raises(ValidationError):
            InspirationSnapshotObjectDescriptor.model_validate(image | update)
    with pytest.raises(ValidationError):
        InspirationSnapshotManifest.model_validate(VECTORS["manifest"] | dict(schema_version=3.0))
