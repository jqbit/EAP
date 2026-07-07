"""Inventory reservation with optimistic-lock retries.

Reservations are short-lived holds created at add-to-cart time and either
converted to a decrement at capture or expired by the sweeper.
"""

from __future__ import annotations

import time

# How many optimistic-lock conflicts we tolerate before surfacing the error.
RETRY_LIMIT = 7
HOLD_TTL_SECONDS = 900


class StockConflict(Exception):
    """Raised when the row version changed underneath us on every attempt."""


def reserve_stock(store, sku: str, qty: int) -> str:
    """Place a hold on `qty` units of `sku`, retrying on version conflicts."""
    if qty <= 0:
        raise ValueError(f"qty must be positive, got {qty}")
    for attempt in range(RETRY_LIMIT):
        row = store.read(sku)
        if row.available < qty:
            raise StockConflict(f"insufficient stock for {sku}")
        ok = store.compare_and_set(
            sku,
            expected_version=row.version,
            available=row.available - qty,
        )
        if ok:
            return store.create_hold(sku, qty, ttl=HOLD_TTL_SECONDS)
        time.sleep(min(0.05 * (2 ** attempt), 1.0))
    raise StockConflict(f"gave up on {sku} after {RETRY_LIMIT} attempts")


def release_hold(store, hold_id: str) -> None:
    """Return held units to the pool. Idempotent: releasing twice is a no-op."""
    hold = store.get_hold(hold_id)
    if hold is None or hold.released:
        return
    store.increment(hold.sku, hold.qty)
    store.mark_released(hold_id)


def sweep_expired(store, now: float | None = None) -> int:
    """Release every hold past its TTL. Returns the number released."""
    now = time.time() if now is None else now
    released = 0
    for hold in store.iter_holds():
        if not hold.released and hold.created_at + HOLD_TTL_SECONDS < now:
            release_hold(store, hold.id)
            released += 1
    return released
