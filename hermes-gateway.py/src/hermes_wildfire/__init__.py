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


def _apply_yaml_config(yaml_cfg: dict[str, Any], platform_cfg: Any) -> dict[str, Any] | None:
    """Translate this plugin's config.yaml keys into PlatformConfig.extra.

    Supported ``config.yaml`` shapes:

        wildfire:
          enabled: true
          gateway_url: ws://localhost:8884/robot/gateway
          ...

        gateway:
          platforms:
            wildfire:
              enabled: true
              ...

    Note: ``home_channel`` is intentionally NOT read from YAML. It must be set
    via the ``WILDFIRE_HOME_CHANNEL`` environment variable (typically in
    ``~/.hermes/.env``) to keep a single source of truth.
    """
    extra: dict[str, Any] = {}

    cfg: Any = None
    if isinstance(yaml_cfg, dict):
        cfg = yaml_cfg.get("wildfire")
        if cfg is None:
            gateway = yaml_cfg.get("gateway", {})
            if isinstance(gateway, dict):
                platforms = gateway.get("platforms", {})
                if isinstance(platforms, dict):
                    cfg = platforms.get("wildfire")
    if not isinstance(cfg, dict):
        return None

    for key in (
        "gateway_url",
        "robot_id",
        "robot_secret",
        "require_mention",
        "help_keywords",
        "allowed_users",
        "allowed_groups",
        "reconnect_interval",
        "heartbeat_interval",
        "request_timeout",
    ):
        if key in cfg:
            extra[key] = cfg[key]

    # Inject missing env vars so the rest of the adapter can read them via
    # os.getenv while preserving env > YAML precedence.
    env_map = {
        "WILDFIRE_GATEWAY_URL": cfg.get("gateway_url", ""),
        "WILDFIRE_ROBOT_ID": cfg.get("robot_id", ""),
        "WILDFIRE_ROBOT_SECRET": cfg.get("robot_secret", ""),
    }
    for env_name, value in env_map.items():
        if value and not os.getenv(env_name):
            os.environ[env_name] = str(value)

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

    def _block_set_home(event: Any, gateway: Any, session_store: Any) -> dict[str, Any] | None:
        """Disable /sethome for Wildfire; home channel must be edited in .env."""
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
            apply_yaml_config_fn=_apply_yaml_config,
            cron_deliver_env_var="WILDFIRE_HOME_CHANNEL",
            emoji="🔥",
            platform_hint="You are chatting via Wildfire IM. Keep responses concise.",
        )
        ctx.register_hook("pre_gateway_dispatch", _block_set_home)
        logger.info("Wildfire IM platform adapter registered")
    except Exception:  # noqa: BLE001
        logger.exception("Failed to register Wildfire IM platform adapter")
