"""Async WebSocket client for the Wildfire robot-gateway protocol."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import websockets
from websockets.protocol import State

logger = logging.getLogger(__name__)


@dataclass
class ConnectResult:
    success: bool
    code: int = 0
    message: str = ""


@dataclass
class ResponseMessage:
    request_id: str
    code: int
    message: str
    result: Any = None

    @property
    def is_success(self) -> bool:
        return self.code == 0


class RobotGatewayClient:
    """WebSocket client that speaks the robot-gateway protocol.

    Supports:
    - connect / authenticate
    - request/response correlation via requestId
    - inbound push-message callback
    - keep-alive heartbeat
    - automatic reconnect with configurable interval
    """

    def __init__(
        self,
        gateway_url: str,
        robot_id: str,
        robot_secret: str,
        *,
        on_push_message: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
        reconnect_interval: float = 5.0,
        heartbeat_interval: float = 180.0,
        request_timeout: float = 30.0,
        reconnect_wait_timeout: float = 2.0,
    ):
        self.gateway_url = gateway_url
        self.robot_id = robot_id
        self.robot_secret = robot_secret
        self.on_push_message = on_push_message
        self.reconnect_interval = reconnect_interval
        self.heartbeat_interval = heartbeat_interval
        self.request_timeout = request_timeout
        self.reconnect_wait_timeout = reconnect_wait_timeout

        self._ws: websockets.WebSocketClientProtocol | None = None
        self._pending: dict[str, asyncio.Future[ResponseMessage]] = {}
        self._running = False
        self._authenticated = False
        self._recv_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._reconnect_task: asyncio.Task | None = None
        # 重连去重：同一时刻最多一个进行中的重连任务、一个已排程的重连
        # 定时器，避免断线处理被多次触发时开出多个并发 WebSocket（并发
        # socket 互相抢鉴权，触发服务端 "Already authenticated" 错误，
        # 进而让自动重连被永久关闭，客户端假死）。
        self._reconnecting = False
        self._connect_event = asyncio.Event()
        self._auth_event = asyncio.Event()
        self._auth_result = ConnectResult(success=False)

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._ws.state == State.OPEN

    @property
    def is_authenticated(self) -> bool:
        return self._authenticated

    async def start(self) -> ConnectResult:
        """Connect and authenticate; returns the auth result."""
        if self._running:
            return self._auth_result
        self._running = True
        await self._connect_and_auth()
        return self._auth_result

    async def stop(self) -> None:
        """Disconnect and cancel all background tasks."""
        self._running = False
        self._cancel_reconnect()
        await self._close_ws()
        await self._cancel_tasks()
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(asyncio.CancelledError("Client stopped"))
        self._pending.clear()

    async def send_request(self, method: str, params: list[Any]) -> ResponseMessage:
        """Send an API request and await the correlated response."""
        if not self._authenticated or not self.is_connected:
            raise RuntimeError("Not connected or not authenticated")

        request_id = str(uuid.uuid4())
        payload = {
            "requestId": request_id,
            "method": method,
            "params": params,
        }

        loop = asyncio.get_event_loop()
        future: asyncio.Future[ResponseMessage] = loop.create_future()
        self._pending[request_id] = future

        try:
            await self._send_json(payload)
            return await asyncio.wait_for(future, timeout=self.request_timeout)
        except asyncio.TimeoutError:
            logger.warning("Request %s method=%s timed out", request_id, method)
            # A timed-out request usually means the connection is dead. Force-close
            # and reconnect immediately so the caller's retry can use a fresh
            # connection instead of failing right away on a dead socket.
            await self._close_ws()
            self._cancel_reconnect()
            self._schedule_reconnect(delay=0)
            # Wait briefly for reconnect/auth so the next retry has a chance to
            # succeed. If reconnect is still in flight we still raise TimeoutError
            # and let the caller decide whether to retry.
            try:
                await asyncio.wait_for(
                    self._auth_event.wait(), timeout=self.reconnect_wait_timeout
                )
            except asyncio.TimeoutError:
                logger.debug(
                    "Request %s reconnect did not complete within %.1fs",
                    request_id,
                    self.reconnect_wait_timeout,
                )
            raise
        finally:
            self._pending.pop(request_id, None)

    # ------------------------------------------------------------------
    # Internal connection helpers
    # ------------------------------------------------------------------

    async def _connect_and_auth(self) -> None:
        # Cancel any stale background tasks from a previous connection so we
        # never end up with two recv loops calling recv() on the same socket.
        await self._cancel_tasks()
        # 建立新连接之前先彻底拆除旧连接（重连竞态保护）：关闭旧 ws 并清理
        # 引用，避免旧连接迟到的 close/消息事件干扰新连接的鉴权。
        await self._close_ws()

        self._connect_event.clear()
        self._auth_event.clear()
        self._auth_result = ConnectResult(success=False)

        try:
            logger.info("Connecting to robot-gateway at %s", self.gateway_url)
            self._ws = await websockets.connect(self.gateway_url, ping_interval=90)
            self._connect_event.set()
            self._recv_task = asyncio.create_task(self._receive_loop(), name="wf-recv")
            self._heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(), name="wf-heartbeat"
            )

            await self._send_json(
                {
                    "type": "connect",
                    "robotId": self.robot_id,
                    "secret": self.robot_secret,
                }
            )

            try:
                await asyncio.wait_for(self._auth_event.wait(), timeout=30.0)
            except asyncio.TimeoutError:
                logger.error("Authentication timed out")
                self._auth_result = ConnectResult(
                    success=False, code=408, message="Authentication timed out"
                )
                await self._close_ws()
        except Exception as exc:  # noqa: BLE001
            logger.error("Failed to connect to robot-gateway: %s", exc)
            self._auth_result = ConnectResult(success=False, code=500, message=str(exc))
            await self._close_ws()
            self._schedule_reconnect()

    async def _receive_loop(self) -> None:
        # Capture the WebSocket reference locally so cleanup never
        # accidentally closes a *newer* connection if self._ws has
        # been replaced by a concurrent reconnect.
        ws = self._ws
        while self._running and ws is not None and self._ws is ws:
            try:
                raw = await ws.recv()
            except websockets.ConnectionClosed as exc:
                # exc.rcvd may be None when no close frame was received from the peer.
                # Prefer the received close frame, then the sent one. ConnectionClosed.code
                # is deprecated in websockets >= 14, so read from the frame directly.
                close_frame = getattr(exc, "rcvd", None) or getattr(exc, "sent", None)
                if close_frame is not None:
                    close_code = close_frame.code
                    close_reason = close_frame.reason
                else:
                    close_code = 1006
                    close_reason = ""
                logger.warning(
                    "robot-gateway connection closed: code=%s reason=%s",
                    close_code,
                    close_reason,
                )
                break
            except Exception as exc:  # noqa: BLE001
                logger.error("Error receiving from robot-gateway: %s", exc)
                break

            await self._handle_message(raw)

        # Loop exited: mark disconnected, fail pending futures, and schedule reconnect
        self._authenticated = False
        # Only close the ws *we* were reading from — self._ws may now point to a
        # brand-new connection if a reconnect raced in.  Closing the new one here
        # would create an infinite connect / disconnect loop.
        if ws is not None and ws.state == State.OPEN:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
        self._fail_pending_futures("Connection lost")
        if self._running:
            self._schedule_reconnect()

    async def _handle_message(self, raw: str | bytes) -> None:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.warning("Invalid JSON from robot-gateway: %s", exc)
            return

        msg_type = data.get("type")
        request_id = data.get("requestId")

        if msg_type == "connect":
            code = data.get("code", 0)
            self._auth_result = ConnectResult(
                success=code == 0,
                code=code,
                message=data.get("msg", ""),
            )
            self._authenticated = self._auth_result.success
            self._auth_event.set()
            if self._authenticated:
                logger.info("Authenticated with robot-gateway as %s", self.robot_id)
            else:
                logger.error("Authentication failed: %s", self._auth_result.message)
                # "Already authenticated" 是并发连接竞态的瞬态错误，不是真正的
                # 鉴权失败（密钥错误）。瞬态错误绝不停止自动重连，否则客户端会
                # 永久假死：拆除当前连接并安排一次（去重后的）重连，等服务端
                # 清理掉旧连接后再重新鉴权。
                if "Already authenticated" in self._auth_result.message:
                    await self._close_ws()
                    self._schedule_reconnect()
                    return
                self._running = False  # 真正的鉴权失败（密钥错误等）不重连
            return

        if msg_type == "heartbeat":
            logger.info("Heartbeat ack received from robot-gateway")
            return

        if msg_type == "message":
            if self.on_push_message is not None:
                try:
                    result = self.on_push_message(data)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:  # noqa: BLE001
                    logger.exception("Push message handler failed")
            return

        if request_id is not None:
            future = self._pending.pop(request_id, None)
            if future is not None and not future.done():
                future.set_result(
                    ResponseMessage(
                        request_id=request_id,
                        code=data.get("code", 0),
                        message=data.get("msg", ""),
                        result=data.get("result"),
                    )
                )
            return

        logger.debug("Unhandled robot-gateway message: %s", data)

    async def _heartbeat_loop(self) -> None:
        while self._running and self.is_connected:
            try:
                await asyncio.sleep(self.heartbeat_interval)
                if self._authenticated and self.is_connected:
                    logger.info("Sending heartbeat to robot-gateway")
                    await self.send_request("heartbeat", [])
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                logger.warning("Heartbeat failed: %s", exc)
                # A failed heartbeat usually means the connection is dead or
                # the server is unresponsive. Force-close so the receive loop
                # detects the disconnect and triggers automatic reconnect.
                await self._close_ws()
                break

    def _schedule_reconnect(self, delay: float | None = None) -> None:
        # 定时器去重：取消还在等待的定时器，多次触发只保留一个排程任务。
        # 正在建立连接的重连任务不取消（防重入由 _reconnecting 入口守卫保证），
        # 这里仍允许新排一个定时器——它触发时会因 _reconnecting 被忽略，
        # 而若进行中的重连被瞬态的 "Already authenticated" 打断，这个定时器
        # 就是下一次重试，不会被丢掉。
        if (
            self._reconnect_task is not None
            and not self._reconnect_task.done()
            and not self._reconnecting
        ):
            self._reconnect_task.cancel()
        self._reconnect_task = asyncio.create_task(
            self._reconnect_after_delay(delay), name="wf-reconnect"
        )

    def _cancel_reconnect(self) -> None:
        if self._reconnect_task is not None and not self._reconnect_task.done():
            self._reconnect_task.cancel()
        self._reconnect_task = None

    async def _reconnect_after_delay(self, delay: float | None = None) -> None:
        await asyncio.sleep(delay if delay is not None else self.reconnect_interval)
        # 防重入：重连进行中忽略并发触发
        if not self._running or self.is_connected or self._reconnecting:
            return
        self._reconnecting = True
        try:
            await self._connect_and_auth()
        finally:
            self._reconnecting = False

    async def _close_ws(self) -> None:
        ws = self._ws
        self._ws = None
        if ws is not None and ws.state == State.OPEN:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

    def _fail_pending_futures(self, message: str) -> None:
        """Fail all pending request futures with the given error message."""
        for request_id, future in list(self._pending.items()):
            if not future.done():
                future.set_exception(RuntimeError(message))
        self._pending.clear()

    async def _cancel_tasks(self) -> None:
        tasks = [self._recv_task, self._heartbeat_task]
        for task in tasks:
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._recv_task = None
        self._heartbeat_task = None

    async def _send_json(self, payload: dict[str, Any]) -> None:
        if self._ws is None or self._ws.state != State.OPEN:
            raise RuntimeError("WebSocket not connected")
        await self._ws.send(json.dumps(payload, ensure_ascii=False))
