"""Inbound media download tests (redirect handling, size cap, policy re-checks)."""

from __future__ import annotations

import httpx
import pytest

from hermes_wildfire.media import (
    MediaDownloadError,
    fetch_media_bytes,
    guess_media_filename,
    is_media_payload_type,
)
from hermes_wildfire.media_policy import MediaUrlError, MediaUrlPolicy
from hermes_wildfire.message import (
    CONTENT_TYPE_FILE,
    CONTENT_TYPE_IMAGE,
    CONTENT_TYPE_TEXT,
    CONTENT_TYPE_VOICE,
)


def test_is_media_payload_type_and_filename():
    assert is_media_payload_type(CONTENT_TYPE_IMAGE)
    assert is_media_payload_type(CONTENT_TYPE_VOICE)
    assert is_media_payload_type(CONTENT_TYPE_FILE)
    assert not is_media_payload_type(CONTENT_TYPE_TEXT)
    assert guess_media_filename({"searchableContent": "报告.pdf"}) == "报告.pdf"
    assert guess_media_filename({}, "http://8.8.8.8/files/a%20b.png") == "a b.png"
    assert guess_media_filename({}, "") == "attachment"


async def test_fetch_media_bytes_ok():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"image-bytes", headers={"content-type": "image/png"})

    data, mime = await fetch_media_bytes(
        "http://8.8.8.8/a.png", transport=httpx.MockTransport(handler)
    )
    assert data == b"image-bytes"
    assert mime == "image/png"


async def test_fetch_media_bytes_follows_and_validates_redirect():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if str(request.url).endswith("/a.png"):
            return httpx.Response(302, headers={"location": "http://8.8.4.4/b.png"})
        return httpx.Response(200, content=b"ok", headers={"content-type": "image/jpeg"})

    data, mime = await fetch_media_bytes(
        "http://8.8.8.8/a.png", transport=httpx.MockTransport(handler)
    )
    assert data == b"ok"
    assert mime == "image/jpeg"
    assert seen == ["http://8.8.8.8/a.png", "http://8.8.4.4/b.png"]


async def test_fetch_media_bytes_rejects_redirect_to_blocked_address():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://127.0.0.1/secret"})

    with pytest.raises(MediaUrlError) as exc:
        await fetch_media_bytes("http://8.8.8.8/a.png", transport=httpx.MockTransport(handler))
    assert exc.value.code == "blocked_loopback"


async def test_fetch_media_bytes_enforces_redirect_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": str(request.url) + "?hop=1"})

    with pytest.raises(MediaUrlError) as exc:
        await fetch_media_bytes(
            "http://8.8.8.8/a.png",
            MediaUrlPolicy(max_redirects=1),
            transport=httpx.MockTransport(handler),
        )
    assert exc.value.code == "redirect_limit"


async def test_fetch_media_bytes_enforces_size_cap():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 1024)

    with pytest.raises(MediaDownloadError) as exc:
        await fetch_media_bytes(
            "http://8.8.8.8/a.png",
            max_bytes=128,
            transport=httpx.MockTransport(handler),
        )
    assert exc.value.code == "too_large"
