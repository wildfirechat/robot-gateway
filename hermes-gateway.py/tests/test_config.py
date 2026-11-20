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
        "WILDFIRE_GROUP_ALLOWED_USERS",
        "WILDFIRE_ALLOW_ALL_USERS",
        "WILDFIRE_GROUP_KEYWORD_TRIGGERS",
        "WILDFIRE_RATE_LIMIT_PER_MINUTE",
        "WILDFIRE_GROUP_RATE_LIMIT_PER_MINUTE",
        "WILDFIRE_PROFILE_FETCH_RETRIES",
        "WILDFIRE_MEDIA_ALLOWED_HOSTS",
        "WILDFIRE_MEDIA_ALLOW_PRIVATE_HOSTS",
        "WILDFIRE_MEDIA_MAX_REDIRECTS",
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


def test_config_access_policy_defaults_are_fail_closed():
    cfg = WildfireConfig.from_platform_config(SimpleNamespace(extra={}))
    assert cfg.allowed_users == set()
    assert cfg.allowed_groups == set()
    assert cfg.group_allowed_users == set()
    assert cfg.allow_all_users is False
    assert cfg.group_keyword_triggers is False


def test_config_access_policy_from_extra():
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(
            extra={
                "allowed_users": "alice,bob",
                "allowed_groups": "group-1",
                "group_allowed_users": "carol",
                "allow_all_users": False,
                "group_keyword_triggers": True,
                "rate_limit_per_minute": 5,
                "group_rate_limit_per_minute": 10,
                "profile_fetch_retries": 2,
            }
        )
    )
    assert cfg.allowed_users == {"alice", "bob"}
    assert cfg.allowed_groups == {"group-1"}
    assert cfg.group_allowed_users == {"carol"}
    assert cfg.group_keyword_triggers is True
    assert cfg.rate_limit_per_minute == 5
    assert cfg.group_rate_limit_per_minute == 10
    assert cfg.profile_fetch_retries == 2


def test_config_access_policy_from_env(monkeypatch):
    monkeypatch.setenv("WILDFIRE_ALLOWED_USERS", "env-user")
    monkeypatch.setenv("WILDFIRE_GROUP_ALLOWED_USERS", "env-group-user")
    monkeypatch.setenv("WILDFIRE_GROUP_KEYWORD_TRIGGERS", "true")
    monkeypatch.setenv("WILDFIRE_RATE_LIMIT_PER_MINUTE", "7")
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(extra={"allowed_users": "extra-user"})
    )
    assert cfg.allowed_users == {"env-user"}
    assert cfg.group_allowed_users == {"env-group-user"}
    assert cfg.group_keyword_triggers is True
    assert cfg.rate_limit_per_minute == 7


def test_config_media_policy_from_nested_extra():
    cfg = WildfireConfig.from_platform_config(
        SimpleNamespace(
            extra={
                "media": {
                    "allowedHosts": ["cdn.example.com", "*.example.org"],
                    "allowPrivateHosts": False,
                    "maxRedirects": 1,
                }
            }
        )
    )
    assert cfg.media_allowed_hosts == ["cdn.example.com", "*.example.org"]
    assert cfg.media_allow_private_hosts is False
    assert cfg.media_max_redirects == 1


def test_config_media_policy_defaults_and_env(monkeypatch):
    cfg = WildfireConfig.from_platform_config(SimpleNamespace(extra={}))
    assert cfg.media_allowed_hosts == []
    assert cfg.media_allow_private_hosts is True
    assert cfg.media_max_redirects == 3

    monkeypatch.setenv("WILDFIRE_MEDIA_ALLOWED_HOSTS", "media.example.com")
    monkeypatch.setenv("WILDFIRE_MEDIA_ALLOW_PRIVATE_HOSTS", "false")
    monkeypatch.setenv("WILDFIRE_MEDIA_MAX_REDIRECTS", "0")
    cfg = WildfireConfig.from_platform_config(SimpleNamespace(extra={}))
    assert cfg.media_allowed_hosts == ["media.example.com"]
    assert cfg.media_allow_private_hosts is False
    assert cfg.media_max_redirects == 0
