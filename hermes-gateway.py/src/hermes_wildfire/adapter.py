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

from hermes_wildfire.client import RobotGatewayClient
from hermes_wildfire.config import WildfireConfig
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

            # Fetch the robot profile and auto-add the owner to the
            # allowed-users list so the robot owner is never locked out.
            try:
                resp = await self._client.send_request(
                    "getProfile", []
                )
                logger.info(
                    "getProfile response: code=%s msg=%s result=%s",
                    resp.code,
                    resp.message,
                    resp.result,
                )
                if resp.is_success and isinstance(resp.result, dict):
                    im_result = resp.result
                    logger.info(
                        "getProfile IMResult: code=%s msg=%s result=%s",
                        im_result.get("code"),
                        im_result.get("msg"),
                        im_result.get("result"),
                    )
                    if im_result.get("code") == 0:
                        profile = im_result.get("result") or {}
                        owner = profile.get("owner")
                        logger.info(
                            "getProfile robot profile: %s, owner=%s",
                            profile,
                            owner,
                        )
                        if owner:
                            self.wf_config.allowed_users.add(str(owner))
                            # Also set owner as home_channel fallback
                            if not self.wf_config.home_channel:
                                self.wf_config.home_channel = str(owner)
                                # Also update the underlying PlatformConfig.home_channel
                                # so gateway's get_home_channel() can find it
                                self.config.home_channel = HomeChannel(
                                    platform=Platform("wildfire"),
                                    chat_id=str(owner),
                                    name="Home",
                                )
                                logger.info(
                                    "Auto-set robot owner %s as Wildfire home_channel fallback",
                                    owner,
                                )
                            logger.info(
                                "Auto-added robot owner %s to Wildfire allowed users",
                                owner,
                            )
            except Exception:  # noqa: BLE001
                logger.warning(
                    "Failed to fetch robot profile for owner, continuing without",
                )

        self._mark_connected()
        logger.info(
            "Wildfire IM connected: robot=%s gateway=%s",
            self.wf_config.robot_id,
            self.wf_config.gateway_url,
        )
        return True

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

        # Authorization
        if not self._is_authorized(sender, conv.get("target", ""), is_group):
            logger.info(
                "Wildfire message from %s blocked by allowlist (group=%s)",
                sender,
                is_group,
            )
            return

        # Group filtering
        if is_group and not should_respond_to_group(
            text,
            self.wf_config.robot_id,
            payload,
            self.wf_config.require_mention,
            self.wf_config.help_keywords,
        ):
            logger.debug(
                "Wildfire group message ignored (no mention/help keyword): %s",
                text[:60],
            )
            return

        media_urls = [media_url] if media_url else []

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
            raw_message=message_data,
            message_type=infer_message_type(payload_type, MessageType),
        )

        await self.handle_message(event)

    def _is_authorized(self, sender: str, chat_id: str, is_group: bool) -> bool:
        if self.wf_config.allow_all_users:
            return True
        if self.wf_config.allowed_users and sender not in self.wf_config.allowed_users:
            return False
        if is_group and self.wf_config.allowed_groups and chat_id not in self.wf_config.allowed_groups:
            return False
        return True

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
