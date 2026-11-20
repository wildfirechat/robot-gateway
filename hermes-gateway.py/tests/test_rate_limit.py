"""Sliding-window rate limiter tests."""

from __future__ import annotations

from hermes_wildfire.rate_limit import SlidingWindowRateLimiter


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_disabled_limiter_always_allows():
    limiter = SlidingWindowRateLimiter(0)
    assert limiter.enabled is False
    for _ in range(100):
        assert limiter.allow("key") is True


def test_limit_is_per_key():
    clock = FakeClock()
    limiter = SlidingWindowRateLimiter(2, window_seconds=60, clock=clock)
    assert limiter.allow("alice") is True
    assert limiter.allow("alice") is True
    assert limiter.allow("alice") is False
    assert limiter.allow("bob") is True


def test_window_slides():
    clock = FakeClock()
    limiter = SlidingWindowRateLimiter(1, window_seconds=60, clock=clock)
    assert limiter.allow("alice") is True
    assert limiter.allow("alice") is False
    clock.advance(59)
    assert limiter.allow("alice") is False
    clock.advance(1.001)
    assert limiter.allow("alice") is True


def test_reset_clears_budget():
    clock = FakeClock()
    limiter = SlidingWindowRateLimiter(1, window_seconds=60, clock=clock)
    assert limiter.allow("alice") is True
    assert limiter.allow("alice") is False
    limiter.reset("alice")
    assert limiter.allow("alice") is True
