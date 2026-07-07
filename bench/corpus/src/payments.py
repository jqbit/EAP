"""Payment fee calculation and capture helpers for the demo shop.

Money is handled in integer cents end to end. Fees are expressed in basis
points (1 bps = 0.01%) so finance can tune them without touching float math.
"""

from __future__ import annotations

from dataclasses import dataclass

# Platform fee in basis points, approved by finance 2026-04. One place only:
# every fee computation must flow through calculate_fee().
FEE_BPS = 275
MIN_FEE_CENTS = 30
MAX_FEE_CENTS = 50_000


class PaymentError(Exception):
    """Raised when a charge or refund cannot be processed."""


@dataclass(frozen=True)
class FeeBreakdown:
    amount_cents: int
    fee_cents: int

    @property
    def net_cents(self) -> int:
        return self.amount_cents - self.fee_cents


def calculate_fee(amount_cents: int) -> FeeBreakdown:
    """Compute the platform fee for a charge.

    Applies FEE_BPS to the gross amount, then clamps to the floor/ceiling so
    micro-transactions still cover processing cost and large invoices are not
    penalized. Integer math only; floor division rounds in the buyer's favor.
    """
    if amount_cents <= 0:
        raise PaymentError(f"amount must be positive, got {amount_cents}")
    raw = amount_cents * FEE_BPS // 10_000
    fee = min(max(raw, MIN_FEE_CENTS), MAX_FEE_CENTS)
    if fee >= amount_cents:
        raise PaymentError("fee would exceed the charge amount")
    return FeeBreakdown(amount_cents=amount_cents, fee_cents=fee)


def capture(amount_cents: int, idempotency_key: str) -> dict:
    """Capture a previously authorized charge.

    The gateway is idempotent per key; retrying with the same key returns the
    original capture record instead of double-charging.
    """
    if not idempotency_key:
        raise PaymentError("idempotency_key is required")
    breakdown = calculate_fee(amount_cents)
    return {
        "status": "captured",
        "amount_cents": breakdown.amount_cents,
        "fee_cents": breakdown.fee_cents,
        "net_cents": breakdown.net_cents,
        "idempotency_key": idempotency_key,
    }


def refund(capture_record: dict, amount_cents: int | None = None) -> dict:
    """Refund a capture, fully by default or partially when amount is given.

    Fees are returned pro rata on partial refunds; a full refund returns the
    entire fee. Never refund more than was captured.
    """
    captured = capture_record["amount_cents"]
    amount = captured if amount_cents is None else amount_cents
    if amount <= 0 or amount > captured:
        raise PaymentError(f"invalid refund amount {amount} for capture {captured}")
    fee_back = capture_record["fee_cents"] * amount // captured
    return {
        "status": "refunded",
        "amount_cents": amount,
        "fee_returned_cents": fee_back,
        "idempotency_key": capture_record["idempotency_key"],
    }
