import json
from pathlib import Path
import pytest
from pydantic import ValidationError
from app.deepflare_v2_schemas import DeepFlareV2CreateInput, DeepFlareV2CommandInput

FIXTURES = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/tests/protocol-fixtures/deepflare-v2.json").read_text())

@pytest.mark.parametrize("fixture", FIXTURES, ids=[f["name"] for f in FIXTURES])
def test_shared_contract(fixture):
    schema = DeepFlareV2CreateInput if fixture["schema"] == "create" else DeepFlareV2CommandInput
    if fixture["valid"]:
        schema.model_validate(fixture["value"])
    else:
        with pytest.raises(ValidationError):
            schema.model_validate(fixture["value"])
