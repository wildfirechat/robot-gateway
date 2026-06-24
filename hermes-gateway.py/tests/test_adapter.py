"""Tests for the WildfireAdapter streaming integration."""

from __future__ import annotations

from typing import Any

import pytest

from hermes_wildfire.adapter import WildfireAdapter
from hermes_wildfire.message import (
    CONTENT_TYPE_STREAMING_GENERATED,
    CONTENT_TYPE_STREAMING_GENERATING,
    CONTENT_TYPE_TEXT,
)


class _FakeClient:
    def __init__(self):
        self.requests: list[tuple[str, list[Any]]] = []
        self.is_authenticated = True
        self._responses: list[dict[str, Any]] = []

    def queue_success(self, result: Any = None) -> None:
        self._responses.append(
            {
                "requestId": "",
                "code": 0,
                "msg": "success",
                "result": result or {"messageUid": 123},
            }
        )

    async def send_request(self, method: str, params: list[Any]) -> Any:
        self.requests.append((method, params))
        response = self._responses.pop(0)
        return _FakeResponse(response)


class _FakeResponse:
    def __init__(self, data: dict[str, Any]):
        self.is_success = data.get("code") == 0
        self.code = data.get("code", 0)
        self.message = data.get("msg", "")
        self.result = data.get("result")


class _FakeConfig:
    extra: dict[str, Any] = {
        "gateway_url": "ws://example.com",
        "robot_id": "robot1",
        "robot_secret": "secret1",
    }


@pytest.fixture
def adapter():
    cfg = _FakeConfig()
    adapter = WildfireAdapter(config=cfg)
    adapter._client = _FakeClient()
    adapter._client.queue_success()
    return adapter


@pytest.mark.asyncio
async def test_send_uses_regular_text_when_no_active_stream(adapter):
    adapter._client.queue_success()
    result = await adapter.send("user:alice", "hello")

    assert result.success
    assert len(adapter._client.requests) == 1
    method, params = adapter._client.requests[0]
    assert method == "sendMessage"
    payload = params[2]
    assert payload["type"] == CONTENT_TYPE_TEXT
    assert payload["searchableContent"] == "hello"


@pytest.mark.asyncio
async def test_send_draft_creates_generating_message(adapter):
    adapter._client.queue_success()
    result = await adapter.send_draft("user:alice", 1, "hello")

    assert result.success
    assert adapter._active_streams.get("user:alice") == "1"
    method, params = adapter._client.requests[0]
    assert method == "sendMessage"
    payload = params[2]
    assert payload["type"] == CONTENT_TYPE_STREAMING_GENERATING
    assert payload["searchableContent"] == "hello"
    assert payload["content"] == "1"


@pytest.mark.asyncio
async def test_send_finalizes_active_stream(adapter):
    # Prime the client with two successful responses.
    adapter._client.queue_success()
    adapter._client.queue_success()

    await adapter.send_draft("user:alice", 1, "hello")
    result = await adapter.send("user:alice", "hello world")

    assert result.success
    assert "user:alice" not in adapter._active_streams
    assert len(adapter._client.requests) == 2

    _, draft_params = adapter._client.requests[0]
    assert draft_params[2]["type"] == CONTENT_TYPE_STREAMING_GENERATING

    _, final_params = adapter._client.requests[1]
    final_payload = final_params[2]
    assert final_payload["type"] == CONTENT_TYPE_STREAMING_GENERATED
    assert final_payload["searchableContent"] == "hello world"
    assert final_payload["content"] == "1"


@pytest.mark.asyncio
async def test_adapter_advertises_draft_streaming(adapter):
    assert adapter.supports_draft_streaming() is True
    assert adapter.prefers_fresh_final_streaming() is False
