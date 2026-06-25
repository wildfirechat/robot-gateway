"""Hermes Agent platform plugin for Wildfire IM."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def check_wildfire_requirements() -> bool:
    """Return True if the Wildfire adapter dependencies are available."""
    try:
        import websockets  # noqa: F401
        from gateway.platforms.base import BasePlatformAdapter  # noqa: F401
        from gateway.config import Platform  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _env_enablement() -> dict[str, Any] | None:
    """Seed PlatformConfig.extra from environment variables.

    This makes env-only setups show up in ``hermes gateway status`` even before
    the adapter is instantiated.
    """
    gateway_url = os.getenv("WILDFIRE_GATEWAY_URL", "").strip()
    robot_id = os.getenv("WILDFIRE_ROBOT_ID", "").strip()
    robot_secret = os.getenv("WILDFIRE_ROBOT_SECRET", "").strip()
    if not gateway_url or not robot_id or not robot_secret:
        return None

    extra: dict[str, Any] = {
        "gateway_url": gateway_url,
        "robot_id": robot_id,
        "robot_secret": robot_secret,
    }
    home_channel = os.getenv("WILDFIRE_HOME_CHANNEL", "").strip()
    if home_channel:
        # Hermes expects home_channel as a {chat_id, name} dict in extra.
        extra["home_channel"] = {"chat_id": home_channel, "name": "Home"}
    return extra


def register(ctx: Any) -> None:
    """Register the Wildfire IM platform adapter with Hermes."""
    if not check_wildfire_requirements():
        logger.warning(
            "hermes-wildfire requirements not met; "
            "ensure 'websockets' is installed and running inside Hermes gateway"
        )
        return

    # Lazy import so plugin discovery does not fail when gateway modules are
    # not yet loaded (e.g. pip entry-point scan at Hermes startup).
    from hermes_wildfire.adapter import WildfireAdapter

    def _block_set_home(
        event: Any,
        gateway: Any,
        session_store: Any,
        **kwargs: Any,
    ) -> dict[str, Any] | None:
        """Disable /sethome for Wildfire; home channel must be edited in .env.

        Accepts **kwargs for forward compatibility with additional hook
        arguments added by future Hermes core versions (e.g.
        ``telemetry_schema_version``).
        """
        source = getattr(event, "source", None)
        if source is None:
            return None
        platform = getattr(source, "platform", None)
        if platform is None or getattr(platform, "value", None) != "wildfire":
            return None
        text = getattr(event, "text", "") or ""
        command = text.strip().split()[0].lower().lstrip("/") if text.strip() else ""
        if command not in ("sethome", "set-home"):
            return None
        return {
            "action": "rewrite",
            "text": (
                "请在 ~/.hermes/.env 中配置 WILDFIRE_HOME_CHANNEL "
                "来设置 Wildfire 的 home channel，本插件不支持 /sethome 命令。"
            ),
        }

    try:
        ctx.register_platform(
            name="wildfire",
            label="Wildfire IM",
            adapter_factory=lambda cfg: WildfireAdapter(cfg),
            check_fn=check_wildfire_requirements,
            required_env=[
                "WILDFIRE_GATEWAY_URL",
                "WILDFIRE_ROBOT_ID",
                "WILDFIRE_ROBOT_SECRET",
            ],
            allowed_users_env="WILDFIRE_ALLOWED_USERS",
            allow_all_env="WILDFIRE_ALLOW_ALL_USERS",
            max_message_length=4096,
            env_enablement_fn=_env_enablement,
            cron_deliver_env_var="WILDFIRE_HOME_CHANNEL",
            emoji="🔥",
            platform_hint="You are chatting via Wildfire IM. Keep responses concise.",
        )
        ctx.register_hook("pre_gateway_dispatch", _block_set_home)
        logger.info("Wildfire IM platform adapter registered")
    except Exception:  # noqa: BLE001
        logger.exception("Failed to register Wildfire IM platform adapter")
