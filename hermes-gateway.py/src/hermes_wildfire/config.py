"""Configuration helpers for the Wildfire IM platform adapter."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class WildfireConfig:
    """Resolved runtime configuration for the Wildfire adapter."""

    gateway_url: str
    robot_id: str
    robot_secret: str
    home_channel: str | None = None
    require_mention: bool = True
    help_keywords: list[str] = field(default_factory=list)
    # DM access: empty allowlist = nobody (fail-closed) unless allow_all_users.
    allowed_users: set[str] = field(default_factory=set)
    # Group access: empty allowlist = no groups (fail-closed) unless allow_all_users.
    allowed_groups: set[str] = field(default_factory=set)
    # Optional sender allowlist applied inside allowed groups (empty = any member).
    group_allowed_users: set[str] = field(default_factory=set)
    allow_all_users: bool = False
    # Group chats answer @mentions only by default; enable ?/help-keyword triggers
    # explicitly (they fire without an @mention).
    group_keyword_triggers: bool = False
    # Per-sender and per-group inbound message limits (0 disables).
    rate_limit_per_minute: int = 20
    group_rate_limit_per_minute: int = 60
    # getProfile retries at connect time before falling back to fail-closed.
    profile_fetch_retries: int = 3
    # Inbound media URL policy (see media_policy.py).
    media_allowed_hosts: list[str] = field(default_factory=list)
    media_allow_private_hosts: bool = True
    media_max_redirects: int = 3
    reconnect_interval: float = 5.0
    reconnect_wait_timeout: float = 2.0
    request_timeout: float = 30.0

    @classmethod
    def from_platform_config(cls, platform_config: Any) -> "WildfireConfig":
        """Build a WildfireConfig from the Hermes PlatformConfig object.

        Values are read from the ``extra`` dict first, then from environment
        variables (env wins over config.yaml as in other adapters).
        """
        extra: dict[str, Any] = getattr(platform_config, "extra", {}) or {}

        gateway_url = _env_or_extra("WILDFIRE_GATEWAY_URL", extra, "gateway_url", "")
        robot_id = _env_or_extra("WILDFIRE_ROBOT_ID", extra, "robot_id", "")
        robot_secret = _env_or_extra("WILDFIRE_ROBOT_SECRET", extra, "robot_secret", "")
        home_channel = _resolve_home_channel(platform_config, extra)

        require_mention = _env_bool(
            "WILDFIRE_REQUIRE_MENTION",
            extra.get("require_mention", True),
        )

        help_keywords = _comma_list(
            os.getenv("WILDFIRE_HELP_KEYWORDS", ""),
            extra.get("help_keywords", "帮,请,分析,总结,怎么,如何"),
        )

        allowed_users = set(
            _comma_list(
                os.getenv("WILDFIRE_ALLOWED_USERS", ""),
                extra.get("allowed_users", ""),
            )
        )

        allowed_groups = set(
            _comma_list(
                os.getenv("WILDFIRE_ALLOWED_GROUPS", ""),
                extra.get("allowed_groups", ""),
            )
        )

        allow_all_users = _env_bool(
            "WILDFIRE_ALLOW_ALL_USERS",
            extra.get("allow_all_users", False),
        )

        group_allowed_users = set(
            _comma_list(
                os.getenv("WILDFIRE_GROUP_ALLOWED_USERS", ""),
                extra.get("group_allowed_users", ""),
            )
        )

        group_keyword_triggers = _env_bool(
            "WILDFIRE_GROUP_KEYWORD_TRIGGERS",
            extra.get("group_keyword_triggers", False),
        )

        rate_limit_per_minute = _env_int(
            "WILDFIRE_RATE_LIMIT_PER_MINUTE",
            extra.get("rate_limit_per_minute", 20),
            minimum=0,
        )
        group_rate_limit_per_minute = _env_int(
            "WILDFIRE_GROUP_RATE_LIMIT_PER_MINUTE",
            extra.get("group_rate_limit_per_minute", 60),
            minimum=0,
        )
        profile_fetch_retries = _env_int(
            "WILDFIRE_PROFILE_FETCH_RETRIES",
            extra.get("profile_fetch_retries", 3),
            minimum=1,
        )

        # Inbound media policy: accept both flat keys and a nested ``media:`` block
        # (matches the DSH plugin's ``media.allowedHosts``/``allowPrivateHosts``).
        media_extra = extra.get("media")
        if not isinstance(media_extra, dict):
            media_extra = {}
        media_allowed_hosts = _comma_list(
            os.getenv("WILDFIRE_MEDIA_ALLOWED_HOSTS", ""),
            media_extra.get("allowedHosts", extra.get("media_allowed_hosts", [])),
        )
        media_allow_private_hosts = _env_bool(
            "WILDFIRE_MEDIA_ALLOW_PRIVATE_HOSTS",
            media_extra.get(
                "allowPrivateHosts", extra.get("media_allow_private_hosts", True)
            ),
        )
        media_max_redirects = _env_int(
            "WILDFIRE_MEDIA_MAX_REDIRECTS",
            media_extra.get("maxRedirects", extra.get("media_max_redirects", 3)),
            minimum=0,
        )

        reconnect_interval = _env_float(
            "WILDFIRE_RECONNECT_INTERVAL",
            extra.get("reconnect_interval", 5.0),
        )
        reconnect_wait_timeout = _env_float(
            "WILDFIRE_RECONNECT_WAIT_TIMEOUT",
            extra.get("reconnect_wait_timeout", 2.0),
        )
        request_timeout = _env_float(
            "WILDFIRE_REQUEST_TIMEOUT",
            extra.get("request_timeout", 30.0),
        )

        return cls(
            gateway_url=gateway_url,
            robot_id=robot_id,
            robot_secret=robot_secret,
            home_channel=home_channel,
            require_mention=require_mention,
            help_keywords=help_keywords,
            allowed_users=allowed_users,
            allowed_groups=allowed_groups,
            group_allowed_users=group_allowed_users,
            allow_all_users=allow_all_users,
            group_keyword_triggers=group_keyword_triggers,
            rate_limit_per_minute=rate_limit_per_minute,
            group_rate_limit_per_minute=group_rate_limit_per_minute,
            profile_fetch_retries=profile_fetch_retries,
            media_allowed_hosts=media_allowed_hosts,
            media_allow_private_hosts=media_allow_private_hosts,
            media_max_redirects=media_max_redirects,
            reconnect_interval=reconnect_interval,
            reconnect_wait_timeout=reconnect_wait_timeout,
            request_timeout=request_timeout,
        )

    def validate(self) -> str | None:
        """Return an error message if the configuration is unusable."""
        if not self.gateway_url:
            return "WILDFIRE_GATEWAY_URL is required"
        if not self.robot_id:
            return "WILDFIRE_ROBOT_ID is required"
        if not self.robot_secret:
            return "WILDFIRE_ROBOT_SECRET is required"
        return None


def _resolve_home_channel(platform_config: Any, extra: dict[str, Any]) -> str | None:
    """Resolve home channel chat_id from env > PlatformConfig.home_channel > extra."""
    env_value = os.getenv("WILDFIRE_HOME_CHANNEL", "").strip()
    if env_value:
        return env_value

    platform_home = getattr(platform_config, "home_channel", None)
    if platform_home is not None:
        chat_id = getattr(platform_home, "chat_id", None)
        if chat_id:
            return str(chat_id).strip() or None

    extra_home = extra.get("home_channel")
    if isinstance(extra_home, dict):
        chat_id = extra_home.get("chat_id") or extra_home.get("chatId")
        if chat_id:
            return str(chat_id).strip() or None
    if extra_home:
        return str(extra_home).strip() or None

    return None


def _env_or_extra(env_name: str, extra: dict[str, Any], extra_key: str, default: str) -> str:
    return os.getenv(env_name, "").strip() or str(extra.get(extra_key, default) or "").strip()


def _env_bool(env_name: str, default: bool) -> bool:
    raw = os.getenv(env_name, "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def _env_float(env_name: str, default: float) -> float:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return float(default)
    try:
        return float(raw)
    except ValueError:
        logger.warning("Invalid %s value '%s', using default %s", env_name, raw, default)
        return float(default)


def _env_int(env_name: str, default: int, *, minimum: int | None = None) -> int:
    raw = os.getenv(env_name, "").strip()
    try:
        value = int(raw) if raw else int(default)
    except (TypeError, ValueError):
        logger.warning("Invalid %s value '%s', using default %s", env_name, raw, default)
        value = int(default)
    if minimum is not None and value < minimum:
        value = minimum
    return value


def _comma_list(env_value: str, extra_value: str | list[str]) -> list[str]:
    raw: str
    if isinstance(extra_value, list):
        raw = ",".join(str(v) for v in extra_value)
    else:
        raw = str(extra_value or "")
    # env overrides the extra list entirely when present
    source = env_value if env_value.strip() else raw
    return [part.strip() for part in source.split(",") if part.strip()]
