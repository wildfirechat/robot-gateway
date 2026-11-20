"""Hermes Agent platform adapter for Wildfire IM."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
from typing import Any, Dict, Optional

from gateway.config import HomeChannel, Platform
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult
from gateway.platforms.helpers import MessageDeduplicator

from hermes_wildfire.access import AccessPolicy
from hermes_wildfire.client import RobotGatewayClient
from hermes_wildfire.config import WildfireConfig
from hermes_wildfire.media import (
    MediaDownloadError,
    cache_inbound_media,
    guess_media_filename,
    is_media_payload_type,
)
from hermes_wildfire.media_policy import MediaUrlError, MediaUrlPolicy, redact_url
from hermes_wildfire.rate_limit import SlidingWindowRateLimiter
from hermes_wildfire.message import (
    CONTENT_TYPE_STREAMING_GENERATED,
    CONTENT_TYPE_STREAMING_GENERATING,
    CONTENT_TYPE_TYPING,
    build_conversation,
    build_file_payload,
    build_image_payload,
    build_message_event,
    build_session_source,
    build_streaming_generated_payload,
    build_streaming_generating_payload,
    build_text_payload,
    build_typing_payload,
    build_video_payload,
    extract_message_text,
    infer_message_type,
    is_group_conversation,
    parse_target,
    should_respond_to_group,
)

logger = logging.getLogger(__name__)


class WildfireAdapter(BasePlatformAdapter):
    """Bridge between Hermes Agent and Wildfire IM via robot-gateway."""

    # Wildfire enforces its own allowlist (allowed_users / allowed_groups) at
    # intake, so the gateway does not double-gate with the env-based allowlist.
    enforces_own_access_policy = True

    # Signal to gateway that we use allowlist-based DM policy so it trusts our
    # _is_authorized decision when no env allowlist is configured.
    _dm_policy = "allowlist"
    _group_policy = "allowlist"

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("wildfire"))

        self.wf_config = WildfireConfig.from_platform_config(config)
        self._client: RobotGatewayClient | None = None
        self._client_lock = asyncio.Lock()

        # Access control: fail-closed allowlists, split between DM and group
        # traffic. The robot owner is learned from getProfile at connect time
        # and always keeps DM access (see access.py).
        self._owner_id: str | None = None
        self._profile_ready = False
        self._access = self._build_access_policy()

        # Inbound media (URL from the message payload) is attacker-controlled:
        # every download goes through this SSRF policy.
        self._media_policy = MediaUrlPolicy(
            allowed_hosts=tuple(self.wf_config.media_allowed_hosts),
            allow_private_hosts=self.wf_config.media_allow_private_hosts,
            max_redirects=self.wf_config.media_max_redirects,
        )
        self._user_rate_limiter = SlidingWindowRateLimiter(
            self.wf_config.rate_limit_per_minute
        )
        self._group_rate_limiter = SlidingWindowRateLimiter(
            self.wf_config.group_rate_limit_per_minute
        )

        # Tracks chat_id -> stream_id for Hermes draft streaming. When a draft
        # stream is active, the next textual ``send()`` finalizes it using
        # Wildfire's StreamingTextGenerated content type.
        self._active_streams: dict[str, str] = {}

        # Deduplicate inbound messages that may arrive multiple times across
        # WebSocket reconnections or robot-gateway redeliveries.
        self._dedup = MessageDeduplicator()

    @property
    def name(self) -> str:
        return "Wildfire IM"

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> bool:
        error = self.wf_config.validate()
        if error:
            logger.error("Wildfire config invalid: %s", error)
            self._set_fatal_error("config_invalid", error, retryable=False)
            return False

        async with self._client_lock:
            self._running = True
            self._client = RobotGatewayClient(
                gateway_url=self.wf_config.gateway_url,
                robot_id=self.wf_config.robot_id,
                robot_secret=self.wf_config.robot_secret,
                on_push_message=self._on_push_message,
                reconnect_interval=self.wf_config.reconnect_interval,
                reconnect_wait_timeout=self.wf_config.reconnect_wait_timeout,
                request_timeout=self.wf_config.request_timeout,
            )
            result = await self._client.start()
            if not result.success:
                logger.error("Wildfire connection failed: %s", result.message)
                self._set_fatal_error(
                    "connect_failed",
                    f"Failed to connect to Wildfire gateway: {result.message}",
                    retryable=result.code not in (401, 403, 404),
                )
                return False

            # Learn the robot owner so DM access keeps working for the operator.
            # Retry: when this fails we stay connected but FAIL CLOSED (nobody is
            # admitted beyond explicitly configured allowlists) — see access.py.
            owner = await self._fetch_owner()
            if owner:
                self._owner_id = owner
                self._profile_ready = True
                self._access = self._build_access_policy()
                if not self.wf_config.home_channel:
                    self.wf_config.home_channel = owner
                    # Also update the underlying PlatformConfig.home_channel so
                    # gateway's get_home_channel() can find it.
                    self.config.home_channel = HomeChannel(
                        platform=Platform("wildfire"),
                        chat_id=owner,
                        name="Home",
                    )
                    logger.info(
                        "Auto-set robot owner %s as Wildfire home_channel fallback", owner
                    )
            else:
                self._profile_ready = False
                self._access = self._build_access_policy()
                logger.error(
                    "Wildfire robot owner unknown after %d getProfile attempt(s); "
                    "access is FAIL-CLOSED (only explicitly configured allowlists apply: "
                    "WILDFIRE_ALLOWED_USERS / WILDFIRE_ALLOWED_GROUPS / "
                    "WILDFIRE_GROUP_ALLOWED_USERS, or WILDFIRE_ALLOW_ALL_USERS)",
                    self.wf_config.profile_fetch_retries,
                )

        self._mark_connected()
        logger.info(
            "Wildfire IM connected: robot=%s gateway=%s access[%s] profile_ready=%s",
            self.wf_config.robot_id,
            self.wf_config.gateway_url,
            self._access.describe(),
            self._profile_ready,
        )
        return True

    async def _fetch_owner(self) -> str | None:
        """Fetch the robot owner via getProfile, retrying transient failures."""
        attempts = max(1, self.wf_config.profile_fetch_retries)
        timeout = min(10.0, max(1.0, float(self.wf_config.request_timeout)))
        for attempt in range(1, attempts + 1):
            try:
                if self._client is None:
                    return None
                resp = await asyncio.wait_for(
                    self._client.send_request("getProfile", []), timeout=timeout
                )
                if not resp.is_success or not isinstance(resp.result, dict):
                    logger.warning(
                        "getProfile failed (attempt %d/%d): code=%s msg=%s",
                        attempt,
                        attempts,
                        resp.code,
                        resp.message,
                    )
                else:
                    im_result = resp.result
                    if im_result.get("code") != 0:
                        logger.warning(
                            "getProfile returned IM code=%s msg=%s (attempt %d/%d)",
                            im_result.get("code"),
                            im_result.get("msg"),
                            attempt,
                            attempts,
                        )
                    else:
                        profile = im_result.get("result") or {}
                        owner = str(profile.get("owner") or "").strip()
                        if owner:
                            logger.info("Wildfire robot owner: %s", owner)
                            return owner
                        logger.warning(
                            "getProfile returned no owner for robot %s (attempt %d/%d)",
                            self.wf_config.robot_id,
                            attempt,
                            attempts,
                        )
            except Exception:  # noqa: BLE001 - retry, then fail closed
                logger.warning(
                    "getProfile request raised (attempt %d/%d)", attempt, attempts, exc_info=True
                )
            if attempt < attempts:
                await asyncio.sleep(min(1.5 * attempt, 5.0))
        return None

    def _build_access_policy(self) -> AccessPolicy:
        return AccessPolicy(
            allowed_users=frozenset(self.wf_config.allowed_users),
            allowed_groups=frozenset(self.wf_config.allowed_groups),
            group_allowed_users=frozenset(self.wf_config.group_allowed_users),
            allow_all_users=self.wf_config.allow_all_users,
            owner_id=self._owner_id,
        )

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()
        async with self._client_lock:
            if self._client is not None:
                await self._client.stop()
                self._client = None

    # ------------------------------------------------------------------
    # Receiving
    # ------------------------------------------------------------------

    async def _on_push_message(self, data: dict[str, Any]) -> None:
        try:
            await self._handle_push_message(data)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to handle Wildfire push message")

    async def _handle_push_message(self, data: dict[str, Any]) -> None:
        message_data = data.get("data") or data
        if not isinstance(message_data, dict):
            logger.debug("Ignoring malformed Wildfire push message")
            return

        sender = message_data.get("sender")
        conv = message_data.get("conv")
        payload = message_data.get("payload")
        message_id = str(message_data.get("messageId") or message_data.get("messageUid") or "")

        if not sender or not conv or not payload:
            logger.debug("Ignoring incomplete Wildfire push message")
            return
        if not isinstance(conv, dict) or not isinstance(payload, dict):
            logger.debug("Ignoring malformed Wildfire push message (conv/payload)")
            return

        # Skip non-text-like content types for now
        payload_type = payload.get("type", 0)
        if payload_type <= 0 or payload_type > 200 or payload_type == CONTENT_TYPE_TYPING:
            return

        # Skip streaming content types (echo from our own streaming sends)
        if payload_type in (CONTENT_TYPE_STREAMING_GENERATING, CONTENT_TYPE_STREAMING_GENERATED):
            return

        # Skip self-messages to prevent echo loops
        sender_id = str(sender)
        if sender_id == self.wf_config.robot_id:
            logger.debug("Ignoring self-message from robot_id=%s", sender_id)
            return

        # Deduplication — WebSocket reconnections may redeliver the same message
        if message_id and self._dedup.is_duplicate(message_id):
            logger.debug("Ignoring duplicate message %s", message_id)
            return

        text, media_url = extract_message_text(payload)
        is_group = is_group_conversation(conv)
        chat_id = str(conv.get("target", ""))

        # Authorization: DM and group rules are separate (see access.py). The
        # policy fails closed when no allowlist is configured at all.
        if not self._is_authorized(sender_id, chat_id, is_group):
            logger.info(
                "Wildfire message from %s blocked by access policy (group=%s chat=%s)",
                sender_id,
                is_group,
                chat_id,
            )
            return

        # Group filtering: mention-only by default; ?/help-keyword triggers are
        # opt-in via WILDFIRE_GROUP_KEYWORD_TRIGGERS.
        if is_group and not should_respond_to_group(
            text,
            self.wf_config.robot_id,
            payload,
            self.wf_config.require_mention,
            self.wf_config.help_keywords,
            keyword_triggers=self.wf_config.group_keyword_triggers,
        ):
            logger.debug(
                "Wildfire group message ignored (no mention): %s",
                (text or "")[:60],
            )
            return

        # Rate limiting: per sender for every chat, plus a per-group budget.
        if not self._user_rate_limiter.allow(f"user:{sender_id}"):
            logger.warning(
                "Wildfire message from %s rate-limited (user budget %d/min)",
                sender_id,
                self.wf_config.rate_limit_per_minute,
            )
            return
        if is_group and not self._group_rate_limiter.allow(f"group:{chat_id}"):
            logger.warning(
                "Wildfire group %s rate-limited (group budget %d/min)",
                chat_id,
                self.wf_config.group_rate_limit_per_minute,
            )
            return

        # Inbound media: the URL is attacker-controlled, so download it only
        # after it passes the SSRF policy, then hand Hermes a local cached path.
        media_urls: list[str] = []
        media_types: list[str] = []
        if media_url and is_media_payload_type(payload_type):
            cached = await self._cache_inbound_media(media_url, payload_type, payload)
            if cached is not None:
                media_urls = [cached[0]]
                media_types = [cached[1]]

        source = build_session_source(
            self.build_source,
            sender=sender,
            conv=conv,
            message_id=message_id,
            robot_id=self.wf_config.robot_id,
        )

        event = build_message_event(
            MessageEvent,
            MessageType,
            source=source,
            text=text,
            message_id=message_id,
            media_urls=media_urls,
            media_types=media_types,
            raw_message=message_data,
            message_type=infer_message_type(payload_type, MessageType),
        )

        await self.handle_message(event)

    async def _cache_inbound_media(
        self, media_url: str, payload_type: int, payload: dict[str, Any]
    ) -> tuple[str, str] | None:
        """Download inbound media safely and cache it; None when unusable."""
        try:
            path, mime = await cache_inbound_media(
                media_url,
                payload_type,
                self._media_policy,
                filename=guess_media_filename(payload, media_url),
            )
            logger.info("Wildfire inbound media cached: %s", path)
            return path, mime
        except MediaUrlError as exc:
            logger.warning(
                "Wildfire inbound media rejected (%s): %s (%s)",
                exc.code,
                redact_url(media_url),
                exc,
            )
        except MediaDownloadError as exc:
            logger.warning(
                "Wildfire inbound media download failed (%s): %s", exc.code, exc
            )
        except Exception:  # noqa: BLE001 - media is best-effort; never drop the text
            logger.exception(
                "Wildfire inbound media download failed: %s", redact_url(media_url)
            )
        return None

    def _is_authorized(self, sender: str, chat_id: str, is_group: bool) -> bool:
        return self._access.is_authorized(str(sender or ""), str(chat_id or ""), is_group)

    def _is_dm_allowed(self, sender_id: str) -> bool:
        """Live DM verdict re-checked by Hermes when no env allowlist exists."""
        return self._access.is_dm_allowed(str(sender_id or ""))

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------

    def supports_draft_streaming(
        self,
        chat_type: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Advertise streaming support via Wildfire IM streaming text types."""
        return True

    def prefers_fresh_final_streaming(
        self,
        content: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Finalize streams in-place using the same Wildfire streamId."""
        return False

    async def send_draft(
        self,
        chat_id: str,
        draft_id: int,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Send a streaming draft update for an in-progress reply.

        Wildfire IM's ``StreamingTextGeneratingMessageContent`` updates the
        message bubble identified by ``stream_id`` each time it is sent, so
        we map Hermes' ``draft_id`` directly to the Wildfire ``stream_id``.
        """
        target = parse_target(chat_id)
        if target is None:
            return SendResult(success=False, error=f"Invalid Wildfire target: {chat_id}")

        client = await self._get_client()
        if client is None or not client.is_authenticated:
            return SendResult(success=False, error="Wildfire client not connected")

        stream_id = str(draft_id)
        self._active_streams[chat_id] = stream_id
        conversation = build_conversation(target)
        payload = build_streaming_generating_payload(content, stream_id)

        try:
            response = await client.send_request(
                "sendMessage",
                [self.wf_config.robot_id, conversation, payload],
            )
            if response.is_success:
                result = response.result or {}
                return SendResult(
                    success=True,
                    message_id=str(result.get("messageUid") or result.get("messageId") or ""),
                )
            # Do not remove from _active_streams on a transient failure; the
            # caller may retry the draft or finalize with a regular message.
            return SendResult(
                success=False,
                error=f"sendMessage draft failed: {response.message} (code={response.code})",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to send Wildfire draft")
            return SendResult(success=False, error=str(exc), retryable=True)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        target = parse_target(chat_id)
        if target is None:
            return SendResult(success=False, error=f"Invalid Wildfire target: {chat_id}")

        client = await self._get_client()
        if client is None or not client.is_authenticated:
            return SendResult(success=False, error="Wildfire client not connected")

        conversation = build_conversation(target)

        # If we have an active draft stream for this chat, finalize it using
        # Wildfire's completed streaming text type with the same streamId.
        stream_id = self._active_streams.pop(chat_id, None)
        if stream_id is not None:
            payload = build_streaming_generated_payload(content, stream_id)
        else:
            payload = build_text_payload(content)

        try:
            response = await client.send_request(
                "sendMessage",
                [self.wf_config.robot_id, conversation, payload],
            )
            if response.is_success:
                result = response.result or {}
                return SendResult(
                    success=True,
                    message_id=str(result.get("messageUid") or result.get("messageId") or ""),
                )
            return SendResult(
                success=False,
                error=f"sendMessage failed: {response.message} (code={response.code})",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to send Wildfire message")
            return SendResult(success=False, error=str(exc), retryable=True)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        """Send a Wildfire typing indicator via ``sendMessage``.

        The robot-gateway protocol does not expose a dedicated typing API, but
        the underlying SDK supports ``TypingMessageContent`` (content type 91).
        We send it as a normal message with a special payload.
        """
        target = parse_target(chat_id)
        if target is None:
            return

        client = await self._get_client()
        if client is None or not client.is_authenticated:
            return

        conversation = build_conversation(target)
        payload = build_typing_payload()

        try:
            await client.send_request(
                "sendMessage",
                [self.wf_config.robot_id, conversation, payload],
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Failed to send Wildfire typing indicator: %s", exc)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        target = parse_target(chat_id)
        if target is None:
            return {"name": chat_id, "type": "dm"}
        return {
            "name": target.id,
            "type": "group" if target.is_group else "dm",
        }

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if caption:
            text_result = await self.send(chat_id, caption)
            if not text_result.success:
                return text_result
        return await self._send_payload(chat_id, build_image_payload(image_url))

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if caption:
            text_result = await self.send(chat_id, caption)
            if not text_result.success:
                return text_result

        payload = await self._build_uploaded_payload(file_path, "file")
        if isinstance(payload, SendResult):
            return payload
        return await self._send_payload(chat_id, payload)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if caption:
            text_result = await self.send(chat_id, caption)
            if not text_result.success:
                return text_result

        payload = await self._build_uploaded_payload(video_path, "video")
        if isinstance(payload, SendResult):
            return payload
        return await self._send_payload(chat_id, payload)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if caption:
            text_result = await self.send(chat_id, caption)
            if not text_result.success:
                return text_result

        payload = await self._build_uploaded_payload(image_path, "image")
        if isinstance(payload, SendResult):
            return payload
        return await self._send_payload(chat_id, payload)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _send_payload(
        self,
        chat_id: str,
        payload: dict[str, Any],
    ) -> SendResult:
        target = parse_target(chat_id)
        if target is None:
            return SendResult(success=False, error=f"Invalid Wildfire target: {chat_id}")

        client = await self._get_client()
        if client is None or not client.is_authenticated:
            return SendResult(success=False, error="Wildfire client not connected")

        conversation = build_conversation(target)
        try:
            response = await client.send_request(
                "sendMessage",
                [self.wf_config.robot_id, conversation, payload],
            )
            if response.is_success:
                result = response.result or {}
                return SendResult(
                    success=True,
                    message_id=str(result.get("messageUid") or result.get("messageId") or ""),
                )
            return SendResult(
                success=False,
                error=f"sendMessage failed: {response.message} (code={response.code})",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Failed to send Wildfire media")
            return SendResult(success=False, error=str(exc), retryable=True)

    async def _build_uploaded_payload(
        self,
        file_path: str,
        media_kind: str,
    ) -> dict[str, Any] | SendResult:
        client = await self._get_client()
        if client is None or not client.is_authenticated:
            return SendResult(success=False, error="Wildfire client not connected")

        try:
            file_size = os.path.getsize(file_path)
        except OSError as exc:
            return SendResult(success=False, error=f"Cannot read file: {exc}")

        # Safety limit: reject files over 50 MB before reading into memory
        MAX_UPLOAD_SIZE = 50 * 1024 * 1024
        if file_size > MAX_UPLOAD_SIZE:
            return SendResult(
                success=False,
                error=f"File too large ({file_size} bytes, max {MAX_UPLOAD_SIZE})",
            )

        name = os.path.basename(file_path)
        mime_type = mimetypes.guess_type(name)[0] or "application/octet-stream"

        try:
            with open(file_path, "rb") as f:
                file_data = f.read()
        except OSError as exc:
            return SendResult(success=False, error=f"Cannot read file: {exc}")

        try:
            response = await client.send_request(
                "uploadFile",
                [file_data, name, 4, mime_type],
            )
            if not response.is_success:
                return SendResult(
                    success=False,
                    error=f"uploadFile failed: {response.message}",
                )
        except Exception as exc:  # noqa: BLE001
            return SendResult(success=False, error=f"uploadFile error: {exc}")

        remote_url = response.result
        if media_kind == "image":
            return build_image_payload(remote_url)
        if media_kind == "video":
            return build_video_payload(remote_url, duration=0)
        return build_file_payload(remote_url, name, file_size)

    async def _get_client(self) -> RobotGatewayClient | None:
        async with self._client_lock:
            return self._client
