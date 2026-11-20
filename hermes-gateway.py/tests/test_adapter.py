"""Tests for the WildfireAdapter streaming integration."""

from __future__ import annotations

from typing import Any

import pytest

from hermes_wildfire.adapter import WildfireAdapter
from hermes_wildfire.message import (
    CONTENT_TYPE_STREAMING_GENERATED,
    CONTENT_TYPE_STREAMING_GENERATING,
    CONTENT_TYPE_TEXT,
    CONTENT_TYPE_TYPING,
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


@pytest.mark.asyncio
async def test_send_typing_uses_typing_content_type(adapter):
    adapter._client.queue_success()
    await adapter.send_typing("user:alice")

    assert len(adapter._client.requests) == 1
    method, params = adapter._client.requests[0]
    assert method == "sendMessage"
    assert params[0] == "robot1"
    assert params[1] == {"type": 0, "target": "alice", "line": 0}
    payload = params[2]
    assert payload["type"] == CONTENT_TYPE_TYPING
    assert payload["content"] == "0"
    assert payload["persistFlag"] == 4


@pytest.mark.asyncio
async def test_send_typing_ignores_invalid_chat_id(adapter):
    await adapter.send_typing("")
    assert len(adapter._client.requests) == 0


@pytest.mark.asyncio
async def test_send_typing_silently_absorbs_send_errors(adapter):
    async def failing_send(_method, _params):
        raise RuntimeError("connection lost")

    adapter._client.send_request = failing_send
    await adapter.send_typing("user:alice")  # should not raise


# ---------------------------------------------------------------------------
# Access policy wiring
# ---------------------------------------------------------------------------


def test_default_adapter_access_is_fail_closed(adapter):
    # No allowlists configured and owner unknown: nobody is admitted.
    assert adapter._is_dm_allowed("owner1") is False
    assert adapter._is_authorized("owner1", "robot1", False) is False
    assert adapter._is_authorized("member1", "group1", True) is False


def test_adapter_dm_and_group_policy_are_split(adapter):
    adapter.wf_config.allowed_groups.add("group1")
    adapter.wf_config.allowed_users.add("owner1")
    adapter._owner_id = "owner1"
    adapter._access = adapter._build_access_policy()

    assert adapter._is_authorized("owner1", "robot1", False) is True
    assert adapter._is_dm_allowed("owner1") is True
    assert adapter._is_authorized("stranger", "robot1", False) is False
    # Other members of an allowed group must not be blocked by the owner's DM allowlist.
    assert adapter._is_authorized("member1", "group1", True) is True
    assert adapter._is_authorized("member1", "group2", True) is False


@pytest.mark.asyncio
async def test_fetch_owner_returns_owner(adapter):
    adapter._client.queue_success({"code": 0, "msg": "success", "result": {"owner": "owner1"}})
    assert await adapter._fetch_owner() == "owner1"


@pytest.mark.asyncio
async def test_fetch_owner_failure_keeps_access_fail_closed(adapter):
    adapter.wf_config.profile_fetch_retries = 1
    adapter._client.queue_success({"code": 1, "msg": "robot not found"})
    assert await adapter._fetch_owner() is None
    assert adapter._is_dm_allowed("owner1") is False


# ---------------------------------------------------------------------------
# Inbound push wiring
# ---------------------------------------------------------------------------


def _push(sender: str, conv: dict, payload: dict, message_id: str = "m1") -> dict:
    return {
        "data": {
            "sender": sender,
            "conv": conv,
            "payload": payload,
            "messageId": message_id,
        }
    }


async def _record_events(adapter) -> list:
    received: list = []

    async def record(event):
        received.append(event)

    adapter.handle_message = record  # type: ignore[assignment]
    return received


@pytest.mark.asyncio
async def test_push_message_from_stranger_is_dropped(adapter):
    received = await _record_events(adapter)
    await adapter._handle_push_message(
        _push("stranger", {"type": 0, "target": "robot1"}, {"type": 1, "searchableContent": "hi"})
    )
    assert received == []


@pytest.mark.asyncio
async def test_push_message_from_owner_is_forwarded(adapter):
    adapter._owner_id = "owner1"
    adapter._access = adapter._build_access_policy()
    received = await _record_events(adapter)
    await adapter._handle_push_message(
        _push("owner1", {"type": 0, "target": "robot1"}, {"type": 1, "searchableContent": "hi"})
    )
    assert len(received) == 1
    assert received[0].source.chat_id == "user:owner1"


@pytest.mark.asyncio
async def test_group_message_needs_mention_by_default(adapter):
    adapter.wf_config.allowed_groups.add("group1")
    adapter._owner_id = "owner1"
    adapter._access = adapter._build_access_policy()
    received = await _record_events(adapter)

    await adapter._handle_push_message(
        _push(
            "member1",
            {"type": 1, "target": "group1"},
            {"type": 1, "searchableContent": "请问这个怎么处理？"},
            message_id="m2",
        )
    )
    assert received == []

    await adapter._handle_push_message(
        _push(
            "member1",
            {"type": 1, "target": "group1"},
            {"type": 1, "searchableContent": "@机器人 你好", "mentionedType": 1, "mentionedTarget": ["robot1"]},
            message_id="m3",
        )
    )
    assert len(received) == 1
    assert received[0].source.chat_id == "group:group1"


@pytest.mark.asyncio
async def test_group_message_ignored_outside_allowlisted_group(adapter):
    adapter.wf_config.allowed_groups.add("group1")
    adapter._owner_id = "owner1"
    adapter._access = adapter._build_access_policy()
    received = await _record_events(adapter)
    await adapter._handle_push_message(
        _push(
            "member1",
            {"type": 1, "target": "group2"},
            {"type": 1, "searchableContent": "hi", "mentionedType": 1, "mentionedTarget": ["robot1"]},
        )
    )
    assert received == []
