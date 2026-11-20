"""Inbound media URL policy tests (SSRF hardening)."""

from __future__ import annotations

import pytest

from hermes_wildfire.media_policy import (
    MediaUrlError,
    MediaUrlPolicy,
    classify_address,
    host_allowed,
    normalize_policy,
    redact_url,
    validate_media_url,
)


def _resolver(mapping: dict[str, str | list[str]]):
    def resolve(hostname: str):
        if hostname not in mapping:
            raise OSError(f"NXDOMAIN: {hostname}")
        value = mapping[hostname]
        return value if isinstance(value, list) else [value]

    return resolve


async def _validate(url: str, policy: MediaUrlPolicy | None = None, mapping=None) -> str:
    return await validate_media_url(url, policy, resolver=_resolver(mapping or {}))


def test_classify_public_address():
    assert classify_address("8.8.8.8") is None
    assert classify_address("1.1.1.1") is None


def test_classify_loopback_link_local_and_metadata():
    assert classify_address("127.0.0.1") == "blocked_loopback"
    assert classify_address("::1") == "blocked_loopback"
    assert classify_address("169.254.1.1") == "blocked_link_local"
    assert classify_address("fe80::1") == "blocked_link_local"
    assert classify_address("169.254.169.254") == "blocked_metadata"
    assert classify_address("100.100.100.200") == "blocked_metadata"
    assert classify_address("fd00:ec2::254") == "blocked_metadata"
    assert classify_address("::ffff:169.254.169.254") == "blocked_metadata"


def test_classify_private_and_reserved():
    assert classify_address("10.1.2.3") == "blocked_private"
    assert classify_address("172.16.0.1") == "blocked_private"
    assert classify_address("192.168.1.1") == "blocked_private"
    assert classify_address("100.64.0.1") == "blocked_private"
    assert classify_address("fc00::1") == "blocked_private"
    assert classify_address("224.0.0.1") == "blocked_reserved"
    assert classify_address("203.0.113.5") == "blocked_reserved"
    assert classify_address("0.0.0.0") == "blocked_reserved"
    assert classify_address("2001:db8::1") == "blocked_reserved"


def test_host_allowlist_matches_exact_and_subdomain_only():
    allowed = ("cdn.example.com", "*.example.org")
    assert host_allowed("cdn.example.com", allowed)
    assert host_allowed("a.example.org", allowed)
    assert not host_allowed("example.org", allowed)  # *. only matches subdomains
    assert not host_allowed("evil.com", allowed)
    assert host_allowed("anything.com", ())  # empty allowlist = unrestricted


async def test_public_url_is_allowed():
    url = await _validate("https://cdn.example.com/a.png", mapping={"cdn.example.com": "8.8.8.8"})
    assert url == "https://cdn.example.com/a.png"


async def test_non_http_scheme_and_credentials_rejected():
    with pytest.raises(MediaUrlError) as exc:
        await _validate("file:///etc/passwd")
    assert exc.value.code == "unsupported_scheme"

    with pytest.raises(MediaUrlError) as exc:
        await _validate("https://user:pass@cdn.example.com/a.png")
    assert exc.value.code == "credentials_not_allowed"


async def test_empty_and_too_long_urls_rejected():
    with pytest.raises(MediaUrlError) as exc:
        await _validate("   ")
    assert exc.value.code == "invalid_url"

    with pytest.raises(MediaUrlError) as exc:
        await _validate("https://example.com/" + "a" * 3000)
    assert exc.value.code == "url_too_long"


async def test_host_allowlist_rejects_unknown_host():
    policy = MediaUrlPolicy(allowed_hosts=("*.example.com",))
    with pytest.raises(MediaUrlError) as exc:
        await _validate("https://evil.com/a.png", policy, {"evil.com": "8.8.8.8"})
    assert exc.value.code == "host_not_allowed"


async def test_hostile_addresses_rejected_even_without_allowlist():
    cases = {
        "http://127.0.0.1/a.png": "blocked_loopback",
        "http://169.254.169.254/latest/meta-data": "blocked_metadata",
        "http://[::1]/a.png": "blocked_loopback",
    }
    for url, code in cases.items():
        with pytest.raises(MediaUrlError) as exc:
            await _validate(url)
        assert exc.value.code == code, url


async def test_private_hosts_allowed_by_default_but_configurable():
    url = "http://192.168.1.10/media/a.png"
    assert await _validate(url) == url
    with pytest.raises(MediaUrlError) as exc:
        await _validate(url, MediaUrlPolicy(allow_private_hosts=False))
    assert exc.value.code == "blocked_private"


async def test_dns_answer_validation_blocks_mixed_answers():
    # One public and one private answer must still be rejected.
    with pytest.raises(MediaUrlError) as exc:
        await _validate(
            "https://media.example.com/a.png",
            MediaUrlPolicy(allow_private_hosts=False),
            {"media.example.com": ["8.8.8.8", "10.0.0.5"]},
        )
    assert exc.value.code == "blocked_private"


async def test_resolution_failure_and_metadata_hostname():
    with pytest.raises(MediaUrlError) as exc:
        await _validate("https://missing.example.com/a.png")
    assert exc.value.code == "resolve_failed"

    with pytest.raises(MediaUrlError) as exc:
        await _validate("http://metadata.google.internal/computeMetadata/v1/")
    assert exc.value.code == "blocked_metadata"


def test_normalize_policy_and_redact_url():
    policy = normalize_policy([" Example.COM. ", "*.Foo.com"], allow_private_hosts=False, max_redirects=-1)
    assert policy.allowed_hosts == ("example.com", "*.foo.com")
    assert policy.allow_private_hosts is False
    assert policy.max_redirects == 3

    redacted = redact_url("https://user:secret@cdn.example.com/a/b.png?token=abc")
    assert "token" not in redacted
    assert "secret" not in redacted
    assert redacted == "https://cdn.example.com/a/b.png"
