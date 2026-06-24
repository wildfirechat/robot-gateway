"""Wildfire IM message payload builders and Hermes event converters."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

# Wildfire IM message content types (match Java/JS SDK)
CONTENT_TYPE_TEXT = 1
CONTENT_TYPE_VOICE = 2
CONTENT_TYPE_IMAGE = 3
CONTENT_TYPE_LOCATION = 4
CONTENT_TYPE_FILE = 5
CONTENT_TYPE_VIDEO = 6

# Wildfire IM streaming text content types
CONTENT_TYPE_STREAMING_GENERATING = 14
CONTENT_TYPE_STREAMING_GENERATED = 15

# Wildfire IM conversation types
CONVERSATION_TYPE_SINGLE = 0
CONVERSATION_TYPE_GROUP = 1
CONVERSATION_TYPE_CHANNEL = 2

# Media types for MessagePayload.mediaType
MEDIA_TYPE_IMAGE = 1
MEDIA_TYPE_VOICE = 2
MEDIA_TYPE_VIDEO = 3
MEDIA_TYPE_FILE = 4


@dataclass(frozen=True)
class WildfireTarget:
    """Parsed Wildfire IM target identifier."""

    id: str
    is_group: bool

    @property
    def conversation_type(self) -> int:
        return CONVERSATION_TYPE_GROUP if self.is_group else CONVERSATION_TYPE_SINGLE


def parse_target(value: str) -> WildfireTarget | None:
    """Parse a target string like ``user:userId`` or ``group:groupId``."""
    value = value.strip()
    if not value:
        return None
    lower = value.lower()
    if lower.startswith("group:"):
        return WildfireTarget(id=value[6:].strip(), is_group=True)
    if lower.startswith("user:"):
        return WildfireTarget(id=value[5:].strip(), is_group=False)
    # Bare ID: assume user by default (Hermes chat_id semantics)
    return WildfireTarget(id=value, is_group=False)


def build_conversation(target: WildfireTarget) -> dict[str, Any]:
    return {
        "type": target.conversation_type,
        "target": target.id,
        "line": 0,
    }


def build_text_payload(text: str) -> dict[str, Any]:
    return {
        "type": CONTENT_TYPE_TEXT,
        "searchableContent": text,
        "content": "",
        "persistFlag": 3,
    }


def build_streaming_generating_payload(text: str, stream_id: str) -> dict[str, Any]:
    """Build a Wildfire streaming-text-generating payload.

    Multiple generating payloads with the same ``stream_id`` update the same
    message bubble on the client. The final payload should use
    :func:`build_streaming_generated_payload` with the same ``stream_id``.
    """
    return {
        "type": CONTENT_TYPE_STREAMING_GENERATING,
        "searchableContent": text,
        "content": stream_id,
        "persistFlag": 3,
    }


def build_streaming_generated_payload(text: str, stream_id: str) -> dict[str, Any]:
    """Build a Wildfire streaming-text-generated (completed) payload."""
    return {
        "type": CONTENT_TYPE_STREAMING_GENERATED,
        "searchableContent": text,
        "content": stream_id,
        "persistFlag": 3,
    }


def build_image_payload(remote_url: str) -> dict[str, Any]:
    return {
        "type": CONTENT_TYPE_IMAGE,
        "searchableContent": "[图片]",
        "content": "",
        "remoteMediaUrl": remote_url,
        "mediaType": MEDIA_TYPE_IMAGE,
        "persistFlag": 3,
    }


def build_video_payload(remote_url: str, duration: int = 0) -> dict[str, Any]:
    return {
        "type": CONTENT_TYPE_VIDEO,
        "searchableContent": "[视频]",
        "content": json.dumps({"d": duration, "duration": duration}),
        "remoteMediaUrl": remote_url,
        "mediaType": MEDIA_TYPE_VIDEO,
        "persistFlag": 3,
    }


def build_file_payload(remote_url: str, name: str, size: int = 0) -> dict[str, Any]:
    return {
        "type": CONTENT_TYPE_FILE,
        "searchableContent": name,
        "content": str(size),
        "remoteMediaUrl": remote_url,
        "mediaType": MEDIA_TYPE_FILE,
        "persistFlag": 3,
    }


def _pick_media_url(payload: dict[str, Any]) -> str | None:
    candidates = [
        payload.get("remoteMediaUrl"),
        payload.get("mediaUrl"),
        payload.get("remoteUrl"),
        payload.get("url"),
    ]
    for value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def extract_message_text(payload: dict[str, Any]) -> tuple[str, str | None]:
    """Return a (preview_text, media_url) tuple for an inbound Wildfire payload."""
    payload_type = payload.get("type", 0)
    media_url = _pick_media_url(payload)

    if payload_type == CONTENT_TYPE_TEXT:
        return payload.get("searchableContent") or payload.get("content") or "", None
    if payload_type == CONTENT_TYPE_VOICE:
        duration = payload.get("duration", 0)
        suffix = f" {duration}s" if duration else ""
        return f"[语音{suffix}]", media_url
    if payload_type == CONTENT_TYPE_IMAGE:
        return "[图片]", media_url
    if payload_type == CONTENT_TYPE_VIDEO:
        return "[视频]", media_url
    if payload_type == CONTENT_TYPE_FILE:
        name = payload.get("searchableContent") or "文件"
        return f"[文件] {name}", media_url

    return payload.get("searchableContent") or f"[暂不支持的消息类型: {payload_type}]", media_url


def is_group_conversation(conv: dict[str, Any]) -> bool:
    return conv.get("type") in (CONVERSATION_TYPE_GROUP, CONVERSATION_TYPE_CHANNEL)


def is_mention(robot_id: str, payload: dict[str, Any]) -> bool:
    """Return True if the message mentions the robot."""
    mentioned_type = payload.get("mentionedType", 0)
    if mentioned_type == 2:  # mention all
        return True
    if mentioned_type == 1 and robot_id in payload.get("mentionedTarget", []):
        return True
    return False


def should_respond_to_group(
    text: str,
    robot_id: str,
    payload: dict[str, Any],
    require_mention: bool,
    help_keywords: list[str],
) -> bool:
    """Apply group chat filtering rules similar to OpenClaw/Moltbot."""
    if is_mention(robot_id, payload):
        return True
    if require_mention:
        # Without mention, only reply to question/help-keyword triggers
        if re.search(r"[?？]$", text.strip()):
            return True
        lower = text.lower()
        if any(kw.lower() in lower for kw in help_keywords):
            return True
        return False
    return True


def build_session_source(
    build_source_fn: Any,
    sender: str,
    conv: dict[str, Any],
    message_id: str | None,
    robot_id: str,
) -> Any:
    """Build a Hermes SessionSource from a Wildfire push message.

    ``chat_id`` is formatted as ``user:<id>`` or ``group:<id>`` so that
    ``parse_target`` can correctly reconstruct the Wildfire conversation when
    Hermes later calls ``send(chat_id, ...)``.

    For single chats, Wildfire's ``conv.target`` is usually the robot itself
    (the recipient), so the reply target must be ``sender``. For groups, the
    reply target is the group ID in ``conv.target``.
    """
    is_group = is_group_conversation(conv)
    chat_type = "group" if is_group else "dm"

    if is_group:
        raw_target = conv.get("target", "")
        chat_id = f"group:{raw_target}"
    else:
        # In a DM the other party is the message sender; conv.target is the
        # robot receiving the message.
        raw_target = sender
        chat_id = f"user:{sender}"

    # Use a stable thread_id for group conversations so Hermes keeps one
    # session per group; for DMs keep thread_id None so the session is keyed
    # by chat_id + user_id.
    thread_id = chat_id if is_group else None

    return build_source_fn(
        chat_id=chat_id,
        chat_name=str(raw_target),
        chat_type=chat_type,
        user_id=str(sender),
        user_name=str(sender),
        thread_id=thread_id,
        message_id=message_id,
    )


def build_message_event(
    MessageEventCls: Any,
    MessageTypeCls: Any,
    source: Any,
    text: str,
    message_id: str | None,
    media_urls: list[str] | None = None,
    raw_message: dict[str, Any] | None = None,
) -> Any:
    """Construct a Hermes MessageEvent from a Wildfire inbound message."""
    return MessageEventCls(
        text=text,
        message_type=MessageTypeCls.TEXT,
        source=source,
        message_id=message_id or "",
        media_urls=list(media_urls or []),
        raw_message=raw_message,
        timestamp=datetime.now(),
    )
