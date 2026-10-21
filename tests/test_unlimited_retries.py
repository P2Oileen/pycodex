import json
from dataclasses import replace

import pytest
import requests

from pycodex import Prompt, ResponsesModelClient, ResponsesProviderConfig
from pycodex.model import (
    ResponsesApiError,
    ResponsesFirstDataTimeout,
    ResponsesRetryableError,
)


def provider(retries=-1):
    return ResponsesProviderConfig(
        "demo", "test", "https://example.com/v1", None,
        stream_max_retries=retries,
    )


def test_unlimited_retry_config_from_toml(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        'model = "demo"\nmodel_provider = "test"\n'
        '[model_providers.test]\nbase_url = "https://example.com/v1"\n'
        'stream_max_retries = -1\n',
        encoding="utf-8",
    )
    config = ResponsesProviderConfig.from_codex_config(path)
    assert config.effective_stream_max_retries() == -1
    assert config.with_overrides(model="other").effective_stream_max_retries() == -1


class Response:
    text = '{"error":{"message":"Please retry after 0.25 seconds."}}'

    def __init__(self, status, stream_failure=False):
        self.status_code = status
        self.stream_failure = stream_failure

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def iter_lines(self, **kwargs):
        event = (
            {"type": "response.failed", "response": {"error": {
                "code": "server_error", "message": "temporary outage",
            }}}
            if self.stream_failure else {"type": "response.completed"}
        )
        yield ("data: " + json.dumps(event)).encode()
        yield b""


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [408, 429, 503, "stream", "connection"])
async def test_unlimited_retries_recover_beyond_default_budget(monkeypatch, failure):
    attempts = []
    delays = []
    events = []

    def send(*args, **kwargs):
        attempts.append(1)
        if len(attempts) <= 15:
            if failure == "connection":
                raise requests.ConnectionError("connection lost")
            return Response(
                200 if failure == "stream" else failure,
                stream_failure=failure == "stream",
            )
        return Response(200)

    async def sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(requests.Session, "send", send)
    monkeypatch.setattr("pycodex.model.asyncio.sleep", sleep)
    client = ResponsesModelClient(provider())
    await client.complete(Prompt(input=[], tools=[]), events.append)

    assert len(attempts) == 16
    retries = [event for event in events if event.kind == "stream_error"]
    assert [event.attempt for event in retries] == list(range(1, 16))
    assert all(event.max_retries == -1 for event in retries)
    assert retries[-1].message == "Reconnecting... 15/∞"
    assert delays == (
        [0.25] * 15 if failure == 429
        else [0.2 * 2 ** min(attempt - 1, 10) for attempt in range(1, 16)]
    )
    assert client._retry_delay_seconds(10 ** 6) == 204.8


@pytest.mark.asyncio
@pytest.mark.parametrize("budget", [0, 1, 5])
async def test_finite_budget_still_stops(monkeypatch, budget):
    attempts = []

    def send(*args, **kwargs):
        attempts.append(1)
        return Response(503)

    async def sleep(seconds):
        pass

    monkeypatch.setattr(requests.Session, "send", send)
    monkeypatch.setattr("pycodex.model.asyncio.sleep", sleep)
    with pytest.raises(ResponsesRetryableError):
        await ResponsesModelClient(provider(budget)).complete(Prompt(input=[], tools=[]))
    assert len(attempts) == budget + 1


@pytest.mark.asyncio
async def test_unlimited_retries_do_not_mask_terminal_errors(monkeypatch):
    attempts = []

    def send(*args, **kwargs):
        attempts.append(1)
        return Response(400)

    monkeypatch.setattr(requests.Session, "send", send)
    with pytest.raises(ResponsesApiError):
        await ResponsesModelClient(provider()).complete(Prompt(input=[], tools=[]))
    assert len(attempts) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["transient", "unavailable", "first_data"])
async def test_unlimited_retries_preserve_fallback_rules(monkeypatch, failure):
    models = []
    events = []

    def send(self, request, **kwargs):
        model = json.loads(request.body)["model"]
        models.append(model)
        if model == "demo":
            if failure == "unavailable":
                response = Response(404)
                response.text = '{"error":{"code":"model_not_found","message":"unknown model"}}'
                return response
            if failure == "first_data":
                raise ResponsesFirstDataTimeout("first data timed out")
            if len(models) <= 15:
                return Response(503)
        return Response(200)

    async def sleep(seconds):
        pass

    monkeypatch.setattr(requests.Session, "send", send)
    monkeypatch.setattr("pycodex.model.asyncio.sleep", sleep)
    client = ResponsesModelClient(replace(provider(), fallback_models=("backup",)))
    await client.complete(Prompt(input=[], tools=[]), events.append)

    assert client.model == "demo"
    if failure == "transient":
        assert models == ["demo"] * 16
        assert not any(event.message.startswith("Falling back:")
                       for event in events if event.kind == "stream_error")
    else:
        assert models == ["demo", "backup"]
        assert any(event.message == "Falling back: demo -> backup"
                   for event in events if event.kind == "stream_error")
