"""Tests for plugin registration helpers in hermes_wildfire.__init__."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hermes_wildfire import _env_enablement
from hermes_wildfire.__init__ import register


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "WILDFIRE_GATEWAY_URL",
        "WILDFIRE_ROBOT_ID",
        "WILDFIRE_ROBOT_SECRET",
        "WILDFIRE_HOME_CHANNEL",
    ):
        monkeypatch.delenv(key, raising=False)


def test_env_enablement_returns_none_when_missing_required():
    assert _env_enablement() is None


def test_env_enablement_seeds_extra_from_env(monkeypatch):
    monkeypatch.setenv("WILDFIRE_GATEWAY_URL", "ws://localhost:8884/robot/gateway")
    monkeypatch.setenv("WILDFIRE_ROBOT_ID", "r1")
    monkeypatch.setenv("WILDFIRE_ROBOT_SECRET", "s1")
    monkeypatch.setenv("WILDFIRE_HOME_CHANNEL", "user:alice")

    extra = _env_enablement()
    assert extra == {
        "gateway_url": "ws://localhost:8884/robot/gateway",
        "robot_id": "r1",
        "robot_secret": "s1",
        "home_channel": {"chat_id": "user:alice", "name": "Home"},
    }


class _FakeEvent:
    def __init__(self, platform_value: str, text: str):
        self.source = SimpleNamespace(
            platform=SimpleNamespace(value=platform_value) if platform_value else None
        )
        self.text = text


def test_register_blocks_set_home_for_wildfire(monkeypatch):
    calls = []

    class _FakeCtx:
        def register_platform(self, **kwargs):
            calls.append(("register_platform", kwargs))

        def register_hook(self, name, handler):
            calls.append(("register_hook", (name, handler)))

    # Make requirements check pass
    monkeypatch.setattr(
        "hermes_wildfire.__init__.check_wildfire_requirements", lambda: True
    )

    register(_FakeCtx())

    call_name, call_args = calls[-1]
    assert call_name == "register_hook"
    name, handler = call_args
    assert name == "pre_gateway_dispatch"

    # /sethome for wildfire should be rewritten to a notice.
    event = _FakeEvent("wildfire", "/sethome")
    result = handler(event, None, None)
    assert result is not None
    assert result["action"] == "rewrite"
    assert "WILDFIRE_HOME_CHANNEL" in result["text"]
    assert "不支持 /sethome" in result["text"]

    # /set-home variant should also be blocked.
    event = _FakeEvent("wildfire", "/set-home")
    result = handler(event, None, None)
    assert result is not None
    assert result["action"] == "rewrite"

    # Normal messages should be allowed.
    event = _FakeEvent("wildfire", "hello")
    assert handler(event, None, None) is None

    # Other platforms should not be affected.
    event = _FakeEvent("telegram", "/sethome")
    assert handler(event, None, None) is None


def test_register_blocks_set_home_accepts_extra_hook_kwargs(monkeypatch):
    """Future Hermes core versions may pass extra kwargs to the hook."""
    calls = []

    class _FakeCtx:
        def register_platform(self, **kwargs):
            calls.append(("register_platform", kwargs))

        def register_hook(self, name, handler):
            calls.append(("register_hook", (name, handler)))

    monkeypatch.setattr(
        "hermes_wildfire.__init__.check_wildfire_requirements", lambda: True
    )

    register(_FakeCtx())

    _name, handler = calls[-1][1]
    event = _FakeEvent("wildfire", "/sethome")
    # Should not raise on unexpected keyword arguments.
    result = handler(
        event,
        None,
        None,
        telemetry_schema_version=1,
    )
    assert result is not None
    assert result["action"] == "rewrite"
