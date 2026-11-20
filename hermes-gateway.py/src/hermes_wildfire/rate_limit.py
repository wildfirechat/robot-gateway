"""Small in-process sliding-window rate limiter for inbound IM messages.

The adapter runs on a single asyncio event loop, so no locking is required for
normal use. ``max_events <= 0`` disables limiting (useful for tests/dev).
"""

from __future__ import annotations

import time
from collections import deque
from typing import Callable


class SlidingWindowRateLimiter:
    """At most *max_events* events per *window_seconds* for each key."""

    def __init__(
        self,
        max_events: int,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = 4096,
    ) -> None:
        self.max_events = int(max_events)
        self.window_seconds = float(window_seconds)
        self._clock = clock
        self._max_keys = max(1, int(max_keys))
        self._events: dict[str, deque[float]] = {}

    @property
    def enabled(self) -> bool:
        return self.max_events > 0

    def allow(self, key: str) -> bool:
        """Record one event for *key*; return False when the window is full."""
        if not self.enabled:
            return True
        now = self._clock()
        cutoff = now - self.window_seconds
        bucket = self._events.get(key)
        if bucket is None:
            if len(self._events) >= self._max_keys:
                self._prune()
            bucket = deque()
            self._events[key] = bucket
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= self.max_events:
            return False
        bucket.append(now)
        return True

    def reset(self, key: str | None = None) -> None:
        if key is None:
            self._events.clear()
        else:
            self._events.pop(key, None)

    def _prune(self) -> None:
        """Drop keys whose windows have fully expired (bounded memory)."""
        now = self._clock()
        cutoff = now - self.window_seconds
        stale = [k for k, q in self._events.items() if not q or q[-1] <= cutoff]
        for key in stale:
            del self._events[key]
        if len(self._events) >= self._max_keys:
            # Hard cap: drop the oldest insertion-order buckets.
            for key in list(self._events)[: len(self._events) // 2]:
                del self._events[key]
