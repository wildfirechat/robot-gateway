"""Hermes Agent platform adapter for Wildfire IM."""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
from typing import Any, Dict, Optional

from gateway.config import Platform
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult

from hermes_wildfire.client import RobotGatewayClient
from hermes_wildfire.config import WildfireConfig
from hermes_wildfire.message import (
    build_conversation,
    build_file_payload,
    build_image_payload,
    build_message_event,
    build_session_source,
    build_streaming_generated_payload,
    build_streaming_generating_payload,
    build_text_payload,
    build_video_payload,
    extract_message_text,
    is_group_conversation,
    parse_target,
    should_respond_to_group,
)

logger = logging.getLogger(__name__)


class WildfireAdapter(BasePlatformAdapter):
    """Bridge between Hermes Agent and Wildfire IM via robot-gateway."""

    MAX_MESSAGE_LENGTH = 4096

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("wildfire"))

        self.wf_config = WildfireConfig.from_platform_config(config)
        self._client: RobotGatewayClient | None = None
        self._client_lock = asyncio.Lock()
        self._running = False

        # Tracks chat_id -> stream_id for Hermes draft streaming. When a draft
        # stream is active, the next textual ``send()`` finalizes it using
        # Wildfire's StreamingTextGenerated content type.
        self._active_streams: dict[str, str] = {}

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
                heartbeat_interval=self.wf_config.heartbeat_interval,
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
        if payload_type <= 0 or payload_type > 200:
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

    def supports_draft_streaming(self) -> bool:
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
        # Wildfire IM has no typing indicator in the robot API.
        pass

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
