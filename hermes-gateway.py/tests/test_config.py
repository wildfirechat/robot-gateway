from types import SimpleNamespace

import pytest

from hermes_wildfire.config import WildfireConfig


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "WILDFIRE_GATEWAY_URL",
        "WILDFIRE_ROBOT_ID",
        "WILDFIRE_ROBOT_SECRET",
        "WILDFIRE_HOME_CHANNEL",
        "WILDFIRE_REQUIRE_MENTION",
        "WILDFIRE_HELP_KEYWORDS",
        "WILDFIRE_ALLOWED_USERS",
        "WILDFIRE_ALLOWED_GROUPS",
        "WILDFIRE_RECONNECT_WAIT_TIMEOUT",
    ):
        monkeypatch.delenv(key, raising=False)


def test_config_from_extra():
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(
            extra={
                "gateway_url": "ws://localhost:8884/robot/gateway",
                "robot_id": "r1",
                "robot_secret": "s1",
                "require_mention": False,
                "help_keywords": "a,b",
            }
        )
    )
    assert cfg.validate() is None
    assert cfg.gateway_url == "ws://localhost:8884/robot/gateway"
    assert cfg.robot_id == "r1"
    assert not cfg.require_mention
    assert cfg.help_keywords == ["a", "b"]


def test_config_env_overrides_extra(monkeypatch):
    monkeypatch.setenv("WILDFIRE_GATEWAY_URL", "ws://env:8884/robot/gateway")
    monkeypatch.setenv("WILDFIRE_ROBOT_ID", "r2")
    monkeypatch.setenv("WILDFIRE_ROBOT_SECRET", "s2")
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(
            extra={
                "gateway_url": "ws://cfg:8884/robot/gateway",
                "robot_id": "r1",
                "robot_secret": "s1",
            }
        )
    )
    assert cfg.gateway_url == "ws://env:8884/robot/gateway"
    assert cfg.robot_id == "r2"


def test_config_missing_required():
    cfg = WildfireConfig.from_platform_config(SimpleNamespace(extra={}))
    assert cfg.validate() == "WILDFIRE_GATEWAY_URL is required"


def test_config_home_channel_from_env(monkeypatch):
    monkeypatch.setenv("WILDFIRE_HOME_CHANNEL", "user:alice")
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(extra={"home_channel": {"chat_id": "group:team", "name": "Home"}})
    )
    assert cfg.home_channel == "user:alice"


def test_config_home_channel_from_extra_dict():
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(extra={"home_channel": {"chat_id": "group:team", "name": "Home"}})
    )
    assert cfg.home_channel == "group:team"


def test_config_home_channel_from_extra_string():
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(extra={"home_channel": "user:bob"})
    )
    assert cfg.home_channel == "user:bob"


def test_config_home_channel_from_platform_config():
    home = SimpleNamespace(chat_id="user:charlie", name="Home")
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(home_channel=home, extra={})
    )
    assert cfg.home_channel == "user:charlie"


def test_config_reconnect_wait_timeout_from_extra():
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(
            extra={
                "gateway_url": "ws://localhost:8884/robot/gateway",
                "robot_id": "r1",
                "robot_secret": "s1",
                "reconnect_wait_timeout": 3.5,
            }
        )
    )
    assert cfg.reconnect_wait_timeout == 3.5


def test_config_reconnect_wait_timeout_from_env(monkeypatch):
    monkeypatch.setenv("WILDFIRE_RECONNECT_WAIT_TIMEOUT", "4.5")
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(
            extra={
                "gateway_url": "ws://localhost:8884/robot/gateway",
                "robot_id": "r1",
                "robot_secret": "s1",
                "reconnect_wait_timeout": 3.5,
            }
        )
    )
    assert cfg.reconnect_wait_timeout == 4.5
