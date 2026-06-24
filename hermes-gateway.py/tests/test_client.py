import asyncio
import json

import pytest
import websockets

from hermes_wildfire.client import RobotGatewayClient


@pytest.fixture
async def mock_gateway():
    """Start a tiny mock robot-gateway and yield its URL."""
    messages = []
    authenticated = asyncio.Event()
    connections: list[websockets.WebSocketServerProtocol] = []

    async def handler(ws):
        connections.append(ws)
        try:
            async for raw in ws:
                data = json.loads(raw)
                messages.append(data)
                msg_type = data.get("type")
                method = data.get("method")
                request_id = data.get("requestId")

                if msg_type == "connect":
                    if data.get("robotId") == "robot1" and data.get("secret") == "secret1":
                        await ws.send(json.dumps({"type": "connect", "code": 0, "msg": "success"}))
                        authenticated.set()
                    else:
                        await ws.send(json.dumps({"type": "connect", "code": 401, "msg": "bad secret"}))
                    continue

                if method == "heartbeat":
                    await ws.send(
                        json.dumps({"requestId": request_id, "code": 0, "msg": "success", "result": 123})
                    )
                    continue

                if method == "sendMessage":
                    await ws.send(
                        json.dumps(
                            {
                                "requestId": request_id,
                                "code": 0,
                                "msg": "success",
                                "result": {"messageUid": 42},
                            }
                        )
                    )
                    continue

                if method == "uploadFile":
                    await ws.send(
                        json.dumps(
                            {
                                "requestId": request_id,
                                "code": 0,
                                "msg": "success",
                                "result": "http://example.com/uploaded.bin",
                            }
                        )
                    )
                    continue

                await ws.send(
                    json.dumps({"requestId": request_id, "code": 500, "msg": "unknown"})
                )
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if ws in connections:
                connections.remove(ws)

    server = await websockets.serve(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    url = f"ws://127.0.0.1:{port}"
    try:
        yield {"url": url, "messages": messages, "authenticated": authenticated, "connections": connections}
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_client_auth_success(mock_gateway):
    client = RobotGatewayClient(
        mock_gateway["url"],
        robot_id="robot1",
        robot_secret="secret1",
    )
    result = await client.start()
    assert result.success
    assert result.code == 0
    mock_gateway["authenticated"].is_set()
    await client.stop()


@pytest.mark.asyncio
async def test_client_auth_failure(mock_gateway):
    client = RobotGatewayClient(
        mock_gateway["url"],
        robot_id="robot1",
        robot_secret="wrong",
    )
    result = await client.start()
    assert not result.success
    assert result.code == 401
    await client.stop()


@pytest.mark.asyncio
async def test_client_send_message(mock_gateway):
    client = RobotGatewayClient(
        mock_gateway["url"],
        robot_id="robot1",
        robot_secret="secret1",
    )
    await client.start()
    response = await client.send_request(
        "sendMessage",
        ["robot1", {"type": 0, "target": "alice", "line": 0}, {"type": 1, "content": "hi"}],
    )
    assert response.is_success
    assert response.result["messageUid"] == 42
    await client.stop()


@pytest.mark.asyncio
async def test_client_push_message(mock_gateway):
    received = []

    async def on_push(data):
        received.append(data)

    client = RobotGatewayClient(
        mock_gateway["url"],
        robot_id="robot1",
        robot_secret="secret1",
        on_push_message=on_push,
    )
    await client.start()

    # Wait until the server has recorded the client connection, then push
    # a synthetic inbound message from the server side.
    for _ in range(50):
        if mock_gateway["connections"]:
            break
        await asyncio.sleep(0.01)
    assert mock_gateway["connections"], "Client did not connect to mock server"

    server_conn = mock_gateway["connections"][0]
    await server_conn.send(
        json.dumps(
            {
                "type": "message",
                "data": {
                    "sender": "alice",
                    "conv": {"type": 0, "target": "alice", "line": 0},
                    "payload": {"type": 1, "searchableContent": "hello"},
                },
            }
        )
    )

    await asyncio.sleep(0.1)
    assert len(received) == 1
    assert received[0]["data"]["sender"] == "alice"
    await client.stop()


@pytest.mark.asyncio
async def test_receive_loop_handles_connection_closed_without_rcvd():
    """_receive_loop must not crash when ConnectionClosed.rcvd is None.

    This reproduces the restart-time bug where the client sent a close frame
    but received none, causing the old getattr(exc, 'rcvd', exc).code access
    to raise AttributeError.
    """

    class FakeWs:
        state = websockets.protocol.State.OPEN

        async def recv(self):
            raise websockets.ConnectionClosedError(
                rcvd=None,
                sent=websockets.frames.Close(1000, "OK"),
                rcvd_then_sent=False,
            )

        async def close(self):
            pass

    client = RobotGatewayClient(
        "ws://localhost:0",
        robot_id="robot1",
        robot_secret="secret1",
    )
    client._ws = FakeWs()  # type: ignore[assignment]
    client._running = True

    await client._receive_loop()

    assert client._ws is None
    assert not client._authenticated


@pytest.mark.asyncio
async def test_heartbeat_failure_closes_connection():
    """A failed heartbeat must close the WebSocket so reconnect can happen."""

    closed = asyncio.Event()

    class FakeWs:
        state = websockets.protocol.State.OPEN

        async def send(self, _data):
            raise RuntimeError("connection broken")

        async def close(self):
            closed.set()

    client = RobotGatewayClient(
        "ws://localhost:0",
        robot_id="robot1",
        robot_secret="secret1",
        heartbeat_interval=0.01,
    )
    client._running = True
    client._authenticated = True
    client._ws = FakeWs()  # type: ignore[assignment]

    await client._heartbeat_loop()

    assert client._ws is None
    assert closed.is_set()
