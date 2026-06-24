"""Tests for plugin registration helpers in hermes_wildfire.__init__."""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

from hermes_wildfire import _apply_yaml_config, _env_enablement
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


def test_apply_yaml_config_ignores_home_channel():
    yaml_cfg = {
        "wildfire": {
            "enabled": True,
            "gateway_url": "ws://localhost:8884/robot/gateway",
            "robot_id": "r1",
            "robot_secret": "s1",
            "home_channel": "user:alice",
        }
    }
    extra = _apply_yaml_config(yaml_cfg, SimpleNamespace(extra={}))
    assert extra is not None
    assert "home_channel" not in extra
    assert "WILDFIRE_HOME_CHANNEL" not in os.environ


def test_apply_yaml_config_sets_credentials():
    yaml_cfg = {
        "wildfire": {
            "enabled": True,
            "gateway_url": "ws://localhost:8884/robot/gateway",
            "robot_id": "r1",
            "robot_secret": "s1",
            "require_mention": False,
        }
    }
    extra = _apply_yaml_config(yaml_cfg, SimpleNamespace(extra={}))
    assert extra is not None
    assert extra["require_mention"] is False
    assert os.environ["WILDFIRE_GATEWAY_URL"] == "ws://localhost:8884/robot/gateway"
    assert os.environ["WILDFIRE_ROBOT_ID"] == "r1"
    assert os.environ["WILDFIRE_ROBOT_SECRET"] == "s1"


def test_apply_yaml_config_returns_none_for_unknown_shape():
    assert _apply_yaml_config({}, SimpleNamespace(extra={})) is None
    assert _apply_yaml_config({"other": {}}, SimpleNamespace(extra={})) is None


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
