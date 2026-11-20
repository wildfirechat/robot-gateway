"""Download and cache inbound Wildfire media safely.

``mediaUrl`` values come from the message payload and are attacker-controlled,
so every fetch goes through :mod:`hermes_wildfire.media_policy`: scheme and
credential checks, optional host allowlist, DNS-answer validation (loopback /
link-local / metadata / private / reserved) and manual redirect following with
per-hop validation.

Once downloaded, bytes are handed to Hermes' cache helpers so the agent gets a
local file path (``media_urls``) exactly like the built-in adapters.
"""

from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import unquote, urlsplit

from hermes_wildfire.media_policy import (
    MediaUrlError,
    MediaUrlPolicy,
    redact_url,
    resolve_redirect,
    validate_media_url,
)
from hermes_wildfire.message import (
    CONTENT_TYPE_FILE,
    CONTENT_TYPE_IMAGE,
    CONTENT_TYPE_VIDEO,
    CONTENT_TYPE_VOICE,
)

logger = logging.getLogger(__name__)

# Matches the DSH plugin's inbound media cap.
MAX_MEDIA_BYTES = 64 * 1024 * 1024
MEDIA_HTTP_TIMEOUT = 30.0

_MEDIA_PAYLOAD_TYPES = frozenset(
    {CONTENT_TYPE_FILE, CONTENT_TYPE_IMAGE, CONTENT_TYPE_VIDEO, CONTENT_TYPE_VOICE}
)

_IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/heic": ".heic",
}
_VIDEO_EXTENSIONS = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
}


class MediaDownloadError(Exception):
    """The media URL passed the policy but downloading failed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def is_media_payload_type(payload_type: int) -> bool:
    return payload_type in _MEDIA_PAYLOAD_TYPES


def guess_media_filename(payload: dict[str, Any], media_url: str = "") -> str:
    """Best-effort attachment name from the payload or URL path."""
    name = str(payload.get("searchableContent") or "").strip()
    if not name and media_url:
        try:
            name = unquote(os.path.basename(urlsplit(media_url).path or ""))
        except ValueError:
            name = ""
    name = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
    name = "".join(ch for ch in name if ord(ch) >= 32)
    return name[:180] or "attachment"


async def fetch_media_bytes(
    url: str,
    policy: MediaUrlPolicy | None = None,
    *,
    max_bytes: int = MAX_MEDIA_BYTES,
    timeout: float = MEDIA_HTTP_TIMEOUT,
    transport: Any = None,
) -> tuple[bytes, str]:
    """Download *url* under *policy*; return ``(bytes, content_type)``.

    Redirects are followed manually (at most ``policy.max_redirects`` hops) and
    every hop is validated by the media policy before it is fetched.
    """
    import httpx

    policy = policy or MediaUrlPolicy()
    current = await validate_media_url(url, policy)

    client_kwargs: dict[str, Any] = {"timeout": timeout, "follow_redirects": False}
    if transport is not None:  # test seam (httpx.MockTransport)
        client_kwargs["transport"] = transport

    try:
        async with httpx.AsyncClient(**client_kwargs) as client:
            for hop in range(policy.max_redirects + 1):
                async with client.stream("GET", current) as response:
                    if 300 <= response.status_code < 400:
                        location = response.headers.get("location")
                        if not location:
                            raise MediaUrlError(
                                "redirect_invalid", "media redirect has no location"
                            )
                        if hop >= policy.max_redirects:
                            raise MediaUrlError(
                                "redirect_limit",
                                f"media redirect exceeds {policy.max_redirects} hop(s)",
                            )
                        current = await validate_media_url(
                            resolve_redirect(current, location), policy
                        )
                        continue
                    response.raise_for_status()
                    content_type = (
                        response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    )
                    buffer = bytearray()
                    async for chunk in response.aiter_bytes():
                        buffer.extend(chunk)
                        if len(buffer) > max_bytes:
                            raise MediaDownloadError(
                                "too_large",
                                f"media exceeds {max_bytes} bytes: {redact_url(current)}",
                            )
                    return bytes(buffer), content_type
    except (MediaUrlError, MediaDownloadError):
        raise
    except Exception as exc:  # noqa: BLE001 - normalize transport failures
        raise MediaDownloadError(
            "fetch_failed", f"media download failed: {redact_url(current)}: {exc}"
        ) from exc

    raise MediaUrlError("redirect_limit", "media redirect limit reached")


async def cache_inbound_media(
    url: str,
    payload_type: int,
    policy: MediaUrlPolicy | None = None,
    *,
    filename: str | None = None,
) -> tuple[str, str]:
    """Download an inbound media URL and cache it; return ``(local_path, mime)``."""
    from gateway.platforms.base import (
        cache_audio_from_bytes_async,
        cache_document_from_bytes_async,
        cache_image_from_bytes_async,
        cache_video_from_bytes_async,
    )

    data, mime = await fetch_media_bytes(url, policy)
    if payload_type == CONTENT_TYPE_IMAGE:
        path = await cache_image_from_bytes_async(data, _IMAGE_EXTENSIONS.get(mime, ".jpg"))
    elif payload_type == CONTENT_TYPE_VOICE:
        # Hermes sniffs the audio container itself and picks the cache extension.
        path = await cache_audio_from_bytes_async(data)
    elif payload_type == CONTENT_TYPE_VIDEO:
        path = await cache_video_from_bytes_async(data, _VIDEO_EXTENSIONS.get(mime, ".mp4"))
    elif payload_type == CONTENT_TYPE_FILE:
        path = await cache_document_from_bytes_async(
            data, filename or "attachment"
        )
    else:  # pragma: no cover - guarded by is_media_payload_type
        raise MediaDownloadError("unsupported_type", f"unsupported media type: {payload_type}")
    return path, mime
