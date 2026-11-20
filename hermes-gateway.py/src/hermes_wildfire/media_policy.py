"""Inbound media URL safety policy (SSRF hardening), ported from the DSH plugin.

The ``mediaUrl`` in an inbound message payload is attacker-controlled: any IM
user can craft a file/image message whose URL points anywhere. Before Hermes
downloads it we must reject:

* non-http(s) schemes and URLs with embedded credentials;
* hosts outside the optional allowlist (``*.example.com`` matches subdomains only);
* loopback, link-local (including cloud metadata endpoints), multicast/reserved
  and non-global addresses;
* private ranges (RFC1918, CGNAT, ULA) unless ``allow_private_hosts`` is on —
  default on so private deployments can keep IM media hosts.

Every DNS answer is validated, and redirects are followed manually so each hop
is validated again. Known residual risk (same as the DSH implementation): DNS
may be rebound between validation and connect; validate-then-connect is the
implemented baseline.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence
from urllib.parse import urljoin, urlsplit, urlunsplit

MAX_URL_LENGTH = 2048

_IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

# Cloud metadata hostnames / addresses are always rejected, even when private
# hosts are allowed (they are the classic SSRF credential-theft target).
_METADATA_HOSTNAMES = frozenset({"metadata.google.internal", "metadata.goog"})
_METADATA_V4 = ("169.254.169.254", "169.254.170.2", "169.254.169.253", "100.100.100.200")
_METADATA_IPS: frozenset[_IPAddress] = frozenset(
    {ipaddress.ip_address(ip) for ip in _METADATA_V4}
    | {ipaddress.ip_address("::ffff:" + ip) for ip in _METADATA_V4}
    | {ipaddress.ip_address("fd00:ec2::254")}
)

_PRIVATE_V4 = tuple(
    ipaddress.ip_network(n)
    for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10")
)
_PRIVATE_V6 = (ipaddress.ip_network("fc00::/7"),)

_RESERVED_V4 = tuple(
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)
_RESERVED_V6 = tuple(
    ipaddress.ip_network(n) for n in ("::/128", "2001:db8::/32", "ff00::/8")
)


class MediaUrlError(Exception):
    """A media URL was rejected by the safety policy."""

    def __init__(self, code: str, message: str, host: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.host = host

    def __str__(self) -> str:
        return f"[{self.code}] {super().__str__()}"


@dataclass(frozen=True)
class MediaUrlPolicy:
    """Resolved media URL policy for one adapter instance."""

    allowed_hosts: tuple[str, ...] = ()
    allow_private_hosts: bool = True
    max_redirects: int = 3


def normalize_policy(
    allowed_hosts: Iterable[str] | None = None,
    allow_private_hosts: bool = True,
    max_redirects: int = 3,
) -> MediaUrlPolicy:
    hosts = tuple(
        str(h).strip().lower().rstrip(".")
        for h in (allowed_hosts or ())
        if str(h).strip()
    )
    redirects = int(max_redirects) if int(max_redirects) >= 0 else 3
    return MediaUrlPolicy(
        allowed_hosts=hosts,
        allow_private_hosts=bool(allow_private_hosts),
        max_redirects=redirects,
    )


def host_allowed(hostname: str, allowed_hosts: Sequence[str]) -> bool:
    """Whether *hostname* matches the optional allowlist (empty = unrestricted)."""
    host = str(hostname or "").strip().lower().rstrip(".")
    if not allowed_hosts:
        return True
    for entry in allowed_hosts:
        if entry.startswith("*."):
            suffix = entry[1:]  # ".example.com"
            if len(host) > len(suffix) and host.endswith(suffix):
                return True
        elif host == entry:
            return True
    return False


def classify_address(address: str | _IPAddress) -> str | None:
    """Return a media policy rejection code for *address*, or None when allowed."""
    try:
        ip = ipaddress.ip_address(str(address).split("%", 1)[0])
    except ValueError:
        return "resolve_failed"
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if ip in _METADATA_IPS:
        return "blocked_metadata"
    if ip.is_loopback:
        return "blocked_loopback"
    if ip.is_link_local:
        return "blocked_link_local"
    private_nets = _PRIVATE_V4 if ip.version == 4 else _PRIVATE_V6
    if any(ip in net for net in private_nets):
        return "blocked_private"
    if ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return "blocked_reserved"
    reserved_nets = _RESERVED_V4 if ip.version == 4 else _RESERVED_V6
    if any(ip in net for net in reserved_nets):
        return "blocked_reserved"
    if not ip.is_global:
        return "blocked_reserved"
    return None


def _default_resolver(hostname: str) -> list[str]:
    """Resolve every A/AAAA answer for *hostname* (sync; called in a thread)."""
    addresses: list[str] = []
    for info in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM):
        address = str(info[4][0])
        if address not in addresses:
            addresses.append(address)
    return addresses


async def validate_media_url(
    raw_url: str,
    policy: MediaUrlPolicy | None = None,
    *,
    resolver: Callable[[str], Sequence[str]] = _default_resolver,
) -> str:
    """Validate a media URL (and every DNS answer); return the normalized URL.

    Raises :class:`MediaUrlError` with a stable ``code`` when rejected.
    """
    policy = policy or MediaUrlPolicy()
    text = str(raw_url or "").strip()
    if not text:
        raise MediaUrlError("invalid_url", "media URL is empty")
    if len(text) > MAX_URL_LENGTH:
        raise MediaUrlError("url_too_long", "media URL is too long")
    try:
        parsed = urlsplit(text)
    except ValueError as exc:
        raise MediaUrlError("invalid_url", f"media URL is invalid: {exc}") from exc
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise MediaUrlError("unsupported_scheme", f"unsupported media URL scheme: {scheme or '?'}")
    if parsed.username or parsed.password:
        raise MediaUrlError("credentials_not_allowed", "media URL must not embed credentials")
    hostname = (parsed.hostname or "").strip().lower().rstrip(".")
    if not hostname:
        raise MediaUrlError("invalid_url", "media URL has no host")
    if any(ch in hostname for ch in "\r\n\t /\\"):
        raise MediaUrlError("invalid_url", "media URL host is invalid")
    if hostname in _METADATA_HOSTNAMES:
        raise MediaUrlError("blocked_metadata", f"media host is a metadata host: {hostname}", hostname)
    if not host_allowed(hostname, policy.allowed_hosts):
        raise MediaUrlError("host_not_allowed", f"media host is not allowed: {hostname}", hostname)

    try:
        literal: _IPAddress | None = ipaddress.ip_address(hostname)
        addresses: Sequence[str] = (str(literal),)
    except ValueError:
        literal = None
        try:
            addresses = await asyncio.to_thread(resolver, hostname)
        except Exception as exc:  # noqa: BLE001 - surface as a policy rejection
            raise MediaUrlError(
                "resolve_failed", f"media host resolution failed: {hostname}: {exc}", hostname
            ) from exc

    if not addresses:
        raise MediaUrlError("resolve_failed", f"media host has no address: {hostname}", hostname)

    for address in addresses:
        reason = classify_address(address)
        if reason is None:
            continue
        if reason == "blocked_private" and policy.allow_private_hosts:
            continue
        raise MediaUrlError(
            reason, f"media host address is blocked: {hostname} ({address})", hostname
        )

    # Rebuild without userinfo; keep host/port/path/query/fragment as sent.
    return urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment))


def resolve_redirect(current_url: str, location: str | None) -> str:
    """Resolve a redirect Location against the current URL (raises on invalid)."""
    if not location:
        raise MediaUrlError("redirect_invalid", "media redirect has no location")
    try:
        return urljoin(current_url, str(location).strip())
    except ValueError as exc:
        raise MediaUrlError("redirect_invalid", f"media redirect location is invalid: {exc}") from exc


def redact_url(url: str, max_length: int = 120) -> str:
    """Host/path-only form of a URL for logs (drops query/fragment/userinfo)."""
    try:
        parsed = urlsplit(str(url or ""))
        host = parsed.hostname or ""
        port = f":{parsed.port}" if parsed.port else ""
        path = parsed.path or ""
        safe = f"{parsed.scheme}://{host}{port}{path}"
    except ValueError:
        safe = str(url or "")
    if len(safe) > max_length:
        safe = safe[: max_length - 1] + "…"
    return safe
