"""Shared test fixtures, including Hermes gateway mocks."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass, field
from typing import Any


class _Platform:
    def __init__(self, name: str):
        self.name = name


def _build_source(
    chat_id: str = "",
    chat_name: str = "",
    chat_type: str = "dm",
    user_id: str = "",
    user_name: str = "",
    thread_id: str | None = None,
    message_id: str = "",
):
    source = types.SimpleNamespace()
    source.chat_id = chat_id
    source.chat_name = chat_name
    source.chat_type = chat_type
    source.user_id = user_id
    source.user_name = user_name
    source.thread_id = thread_id
    source.message_id = message_id
    return source


@dataclass
class _SendResult:
    success: bool = True
    error: str | None = None
    message_id: str | None = None
    retryable: bool = False


@dataclass
class _MessageEvent:
    text: str = ""
    message_type: Any = None
    source: Any = None
    message_id: str | None = None
    media_urls: list[str] = field(default_factory=list)
    raw_message: dict[str, Any] | None = None
    timestamp: Any = None


class _MessageType:
    TEXT = "text"


class _BasePlatformAdapter:
    def __init__(self, config: Any = None, platform: Any = None):
        self.config = config
        self.platform = platform

    def _mark_connected(self) -> None:
        pass

    def _mark_disconnected(self) -> None:
        pass

    def _set_fatal_error(self, code: str, message: str, retryable: bool = True) -> None:
        pass

    async def handle_message(self, event: Any) -> None:
        pass

    def build_source(self, **kwargs: Any):
        return _build_source(**kwargs)


# Build a minimal fake Hermes gateway package tree.
gateway_pkg = types.ModuleType("gateway")
gateway_config_mod = types.ModuleType("gateway.config")
gateway_config_mod.Platform = _Platform
gateway_pkg.config = gateway_config_mod

gateway_platforms_pkg = types.ModuleType("gateway.platforms")
gateway_platforms_base_mod = types.ModuleType("gateway.platforms.base")
gateway_platforms_base_mod.BasePlatformAdapter = _BasePlatformAdapter
gateway_platforms_base_mod.MessageEvent = _MessageEvent
gateway_platforms_base_mod.MessageType = _MessageType
gateway_platforms_base_mod.SendResult = _SendResult
gateway_platforms_pkg.base = gateway_platforms_base_mod
gateway_pkg.platforms = gateway_platforms_pkg

sys.modules["gateway"] = gateway_pkg
sys.modules["gateway.config"] = gateway_config_mod
sys.modules["gateway.platforms"] = gateway_platforms_pkg
sys.modules["gateway.platforms.base"] = gateway_platforms_base_mod
