"""Transport fault tests, not paid-provider acceptance or generated-image evidence."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers import resolve_layer_provider
from app.providers.http_providers import FalLayerProvider

client = TestClient(app)
ENDPOINT = "fal-ai/qwen-image-layered"
REQUEST_ID = "7e9ca34f-90ee-403c-acf0-734a27e89440"
SOURCE = "https://source.invalid/image.png"
TICKET = {"requestId": REQUEST_ID, "endpointId": ENDPOINT}
BODY = {"imageUrl": SOURCE, "layerCount": 7, "providerRetryPolicy": "never"}
OUTPUT = {"images": [{"url": "https://v3.fal.media/a.png", "width": 640, "height": 640}], "seed": 77}


@pytest.fixture
def install_provider():
    def install(handler, *, base="", model=""):
        provider = FalLayerProvider(base, "private-layer-key", model, transport=httpx.MockTransport(handler))
        app.dependency_overrides[resolve_layer_provider] = lambda: provider
        return provider
    yield install
    app.dependency_overrides.pop(resolve_layer_provider, None)


def test_submit_is_one_post_and_polls_resume_with_gets_only(install_provider):
    calls = []
    states = iter(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"])
    def handler(req):
        calls.append((req.method, str(req.url)))
        assert req.headers["authorization"] == "Key private-layer-key"
        assert req.headers["x-fal-no-retry"] == "1"
        assert all(value <= 15 for value in req.extensions["timeout"].values())
        if req.method == "POST":
            assert req.url.path == f"/{ENDPOINT}"
            assert req.headers["x-fal-request-start-timeout"] == "360"
            assert json.loads(req.content)["num_layers"] == 7
            assert "prompt" not in json.loads(req.content)
            # These untrusted convenience URLs must never receive our key.
            return httpx.Response(200, json={"request_id": REQUEST_ID, "status_url": "https://evil.invalid", "response_url": "http://127.0.0.1/secret"})
        if req.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": next(states), "request_id": REQUEST_ID, "response_url": "https://evil.invalid"})
        assert req.url.path == f"/{ENDPOINT}/requests/{REQUEST_ID}"
        return httpx.Response(200, json=OUTPUT)
    install_provider(handler)
    assert client.post("/v1/decompose/submit", json=BODY).json() == TICKET
    for expected in ("IN_QUEUE", "IN_PROGRESS", "COMPLETED"):
        response = client.post("/v1/decompose/poll", json={**TICKET, "providerRetryPolicy": "never"})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == expected
    final = response.json()["result"]
    assert final["seed"] == 77 and final["layers"][0]["width"] == 640
    assert final["usage"]["provider"] == "FalLayerProvider"
    assert len(calls) == 5 and sum(method == "POST" for method, _ in calls) == 1
    assert all(url.startswith(f"https://queue.fal.run/{ENDPOINT}") for _, url in calls)


@pytest.mark.parametrize("base,model", [
    ("https://gateway.invalid/fal-ai/qwen-image-layered", ENDPOINT),
    ("http://fal.run/fal-ai/qwen-image-layered", ENDPOINT),
    ("https://fal.run.evil.invalid/fal-ai/qwen-image-layered", ENDPOINT),
    ("https://user:secret@fal.run/fal-ai/qwen-image-layered", ENDPOINT),
    ("https://fal.run:444/fal-ai/qwen-image-layered", ENDPOINT),
    ("https://fal.run/fal-ai/qwen-image-layered?token=private", ENDPOINT),
    ("https://fal.run/fal-ai/qwen-image-layered#fragment", ENDPOINT),
    ("https://fal.run/fal-ai/qwen-image-layered/../other", ENDPOINT),
    ("https://fal.run/fal-ai/qwen-image-layered", "fal-ai/other"),
    ("https://fal.run/fal-ai/qwen-image-layered/custom", "fal-ai/qwen-image-layered/custom"),
])
def test_untrusted_or_mismatched_configuration_never_receives_credentials(install_provider, base, model):
    calls = []
    install_provider(lambda req: calls.append(req), base=base, model=model)
    response = client.post("/v1/decompose/submit", json=BODY)
    assert response.status_code == 503
    assert "official Fal" in response.text
    assert "private" not in response.text
    assert not calls


@pytest.mark.parametrize("bad", ["../other", "id/other", "id?token=x", "id#fragment", "", "a" * 129, 123])
def test_unsafe_request_id_is_rejected_before_network(install_provider, bad):
    calls = []
    install_provider(lambda req: calls.append(req))
    assert client.post("/v1/decompose/poll", json={**TICKET, "requestId": bad, "providerRetryPolicy": "never"}).status_code == 422
    assert not calls


@pytest.mark.parametrize("patch", [{"endpointId": "fal-ai/other"}, {"endpointId": "fal-ai/../other"}, {"statusUrl": "https://evil.invalid"}])
def test_checkpoint_cannot_select_another_model_or_arbitrary_url(install_provider, patch):
    calls = []
    install_provider(lambda req: calls.append(req))
    response = client.post("/v1/decompose/poll", json={**TICKET, "providerRetryPolicy": "never", **patch})
    assert response.status_code in (422, 503)
    assert not calls


@pytest.mark.parametrize("path", ["/v1/decompose/submit", "/v1/decompose/poll"])
def test_queue_requires_explicit_single_attempt_policy_and_real_provider(path):
    body = BODY if path.endswith("submit") else {**TICKET, "providerRetryPolicy": "never"}
    assert client.post(path, json=body).status_code == 503  # env test provider is mock
    without_policy = {key: value for key, value in body.items() if key != "providerRetryPolicy"}
    assert client.post(path, json=without_policy).status_code in (422, 503)


@pytest.mark.parametrize("path", ["/v1/decompose", "/v1/decompose/submit", "/v1/decompose/poll"])
def test_timeout_is_classified_and_never_retried(install_provider, path, caplog):
    calls = []
    def handler(req):
        calls.append(req)
        raise httpx.ReadTimeout("private-layer-key private-prompt", request=req)
    install_provider(handler)
    response = client.post(path, json={**TICKET, "providerRetryPolicy": "never"} if path.endswith("poll") else BODY,
                           headers={"X-Novart-Request-Id": "sdr_" + "a" * 32})
    assert len(calls) == 1 and response.status_code == 504
    assert response.json()["error"] == {"code": "PROVIDER_TIMEOUT", "stage": "provider", "upstreamStatus": None}
    assert "sdr_" + "a" * 32 in caplog.text
    assert "private" not in response.text + caplog.text


@pytest.mark.parametrize("http_status,code", [(401, "PROVIDER_AUTH"), (403, "PROVIDER_AUTH"), (422, "PROVIDER_REQUEST_REJECTED"), (429, "PROVIDER_RATE_LIMITED"), (503, "PROVIDER_UNAVAILABLE")])
def test_sync_and_queue_http_failures_have_safe_taxonomy(install_provider, http_status, code):
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(http_status, text="private-secret-body")
    install_provider(handler)
    for path in ("/v1/decompose", "/v1/decompose/submit"):
        response = client.post(path, json=BODY)
        assert response.status_code == 502
        assert response.json()["error"]["code"] == code
        assert response.json()["error"]["upstreamStatus"] == http_status
        assert "private" not in response.text
    assert len(calls) == 2


@pytest.mark.parametrize("payload", [[], {}, {"request_id": "../wrong"}, {"request_id": "a" * 129}, {"request_id": 5}])
def test_submit_rejects_unknown_acceptance_without_replaying(install_provider, payload):
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(200, json=payload)
    install_provider(handler)
    response = client.post("/v1/decompose/submit", json=BODY)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "PROVIDER_INVALID_RESPONSE"
    assert len(calls) == 1


@pytest.mark.parametrize("payload", [
    {"images": []}, {"images": "bad"}, {"images": [None]},
    {"images": [{"url": "file:///private", "width": 1, "height": 1}]},
    {"images": [{"url": "https://v3.fal.media/a.png", "width": 0, "height": 1}]},
    {"images": [{"url": "https://v3.fal.media/a.png", "width": "640", "height": 1}]},
])
def test_malformed_image_result_is_classified(install_provider, payload):
    install_provider(lambda req: httpx.Response(200, json=payload))
    response = client.post("/v1/decompose", json=BODY)
    assert response.status_code == 502 and response.json()["error"]["code"] == "PROVIDER_INVALID_RESPONSE"


def test_official_image_response_allows_omitted_dimensions(install_provider):
    install_provider(lambda req: httpx.Response(200, json={"images": [{"url": "https://v3.fal.media/a.png"}]}))
    response = client.post("/v1/decompose", json=BODY)
    assert response.status_code == 200
    assert response.json()["layers"] == [{"imageUrl": "https://v3.fal.media/a.png", "width": 1, "height": 1}]


def test_malformed_json_and_redirect_are_not_followed_or_leaked(install_provider):
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(302, headers={"Location": "https://evil.invalid/?key=private"})
    install_provider(handler)
    response = client.post("/v1/decompose/submit", json=BODY)
    assert response.status_code == 502 and len(calls) == 1
    assert "evil" not in response.text and "private" not in response.text
    install_provider(lambda req: httpx.Response(200, text="private malformed json"))
    response = client.post("/v1/decompose", json=BODY)
    assert response.json()["error"]["code"] == "PROVIDER_INVALID_RESPONSE"


def test_failed_completed_request_fetches_only_result_and_never_resubmits(install_provider):
    calls = []
    def handler(req):
        calls.append(req.method)
        if req.url.path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED", "error": "private", "request_id": REQUEST_ID})
        return httpx.Response(422, text="private provider validation")
    install_provider(handler)
    response = client.post("/v1/decompose/poll", json={**TICKET, "providerRetryPolicy": "never"})
    assert calls == ["GET", "GET"]
    assert response.json()["error"]["code"] == "PROVIDER_REQUEST_REJECTED"
    assert "private" not in response.text


@pytest.mark.parametrize("payload", [{"status": "UNKNOWN"}, {"status": "COMPLETED", "request_id": "another-job"}, {"status": None}])
def test_ambiguous_status_never_fetches_an_unrelated_result(install_provider, payload):
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(200, json=payload)
    install_provider(handler)
    response = client.post("/v1/decompose/poll", json={**TICKET, "providerRetryPolicy": "never"})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "PROVIDER_INVALID_RESPONSE"
    assert len(calls) == 1 and calls[0].method == "GET"


def test_connection_failure_is_network_error_and_does_not_replay(install_provider):
    calls = []
    def handler(req):
        calls.append(req)
        raise httpx.ConnectError("private connection detail", request=req)
    install_provider(handler)
    response = client.post("/v1/decompose/submit", json=BODY)
    assert response.json()["error"]["code"] == "PROVIDER_NETWORK" and len(calls) == 1
    assert "private" not in response.text


def test_health_declares_resumable_queue_capability():
    assert client.get("/health").json()["studioDecompositionQueueRevision"] == "studio-layer-queue-r2"


@pytest.mark.parametrize("path", ["/v1/decompose", "/v1/decompose/submit"])
@pytest.mark.parametrize("caption", [None, "A person in a red coat stands before a blue wall with lettering."])
def test_fal_uses_only_source_caption_never_editing_intent(install_provider, path, caption):
    calls = []
    def handler(req):
        calls.append(json.loads(req.content))
        return httpx.Response(200, json={"request_id": REQUEST_ID} if path.endswith("submit") else OUTPUT)
    install_provider(handler)
    body = {**BODY, "intent": "Put the person and every letter in separate layers"}
    if caption is not None:
        body["sourceCaption"] = "  " + caption + "  "
    assert client.post(path, json=body).status_code == 200
    assert len(calls) == 1
    if caption is None:
        assert "prompt" not in calls[0]
    else:
        assert calls[0]["prompt"] == caption
    assert "intent" not in calls[0] and "sourceCaption" not in calls[0]


@pytest.mark.parametrize("caption", [None, "", " \t\ufeff", 123, "a" * 2001, "😀" * 1001])
def test_invalid_caption_is_rejected_before_paid_submit(install_provider, caption):
    calls = []
    install_provider(lambda req: calls.append(req))
    assert client.post("/v1/decompose/submit", json={**BODY, "sourceCaption": caption}).status_code == 422
    assert calls == []
