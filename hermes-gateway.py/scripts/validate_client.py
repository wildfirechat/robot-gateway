"""Standalone validation script for the Wildfire robot-gateway client.

Run without Hermes to verify the WebSocket protocol against a real or mock
robot-gateway instance.

Example with a mock server:
    python scripts/validate_client.py ws://localhost:8884/robot/gateway robotId secret
"""

from __future__ import annotations

import asyncio
import sys

from hermes_wildfire.client import RobotGatewayClient


async def main() -> int:
    if len(sys.argv) < 4:
        print(f"Usage: {sys.argv[0]} <gateway-url> <robot-id> <robot-secret>")
        return 1

    gateway_url, robot_id, robot_secret = sys.argv[1:4]

    async def on_push(data: dict) -> None:
        print("[PUSH]", data)

    client = RobotGatewayClient(
        gateway_url=gateway_url,
        robot_id=robot_id,
        robot_secret=robot_secret,
        on_push_message=on_push,
        reconnect_interval=5.0,
    )

    result = await client.start()
    print(f"Auth result: success={result.success} code={result.code} msg={result.message}")
    if not result.success:
        return 1

    try:
        print("Listening for push messages. Press Ctrl+C to exit.")
        while True:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        await client.stop()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
