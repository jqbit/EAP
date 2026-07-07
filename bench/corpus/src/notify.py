"""Order notification fan-out.

Each event is delivered to every subscribed channel; failures on one channel
never block the others. Deliveries are deduped by (event_id, channel).
"""

from __future__ import annotations

CHANNELS = ("email", "webhook", "sms")


def fan_out(event: dict, transports: dict, seen: set) -> list:
    """Deliver `event` on every channel, skipping duplicates.

    Returns a list of (channel, ok) tuples so the caller can record partial
    failures without raising past the loop.
    """
    results = []
    for channel in CHANNELS:
        key = (event["id"], channel)
        if key in seen:
            results.append((channel, True))
            continue
        transport = transports.get(channel)
        if transport is None:
            results.append((channel, False))
            continue
        try:
            transport.send(event)
            seen.add(key)
            results.append((channel, True))
        except Exception:
            results.append((channel, False))
    return results
