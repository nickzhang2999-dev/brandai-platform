"""Shared fixtures. Force the deterministic mock providers so the suite is
hermetic and needs zero API keys (the P0 contract guarantee)."""
import os

import pytest

os.environ["IMAGE_PROVIDER"] = "mock"
os.environ["VLM_PROVIDER"] = "mock"
os.environ["IMAGE_PROVIDER_API_KEY"] = ""
os.environ["VLM_PROVIDER_API_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client() -> TestClient:
    return TestClient(app)


def find_nulls(value, path="$"):
    """Recursively collect JSON paths whose value is None.

    This is the core invariant checker: the FastAPI<->Zod contract boundary
    breaks whenever a response carries an explicit null, because the shared
    Zod schemas use `.optional()` (rejects null) not `.nullable()`.
    """
    hits: list[str] = []
    if value is None:
        hits.append(path)
    elif isinstance(value, dict):
        for k, v in value.items():
            hits += find_nulls(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            hits += find_nulls(v, f"{path}[{i}]")
    return hits
