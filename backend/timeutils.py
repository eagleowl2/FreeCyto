"""Shared time helpers.

Kept at the top level (not under ``models/`` or ``services/``) so both layers can
import it without violating the existing one-way ``services -> models``
dependency direction.
"""

from __future__ import annotations

from datetime import datetime, timezone

__all__ = ["utcnow"]


def utcnow() -> datetime:
    """Naive UTC timestamp — drop-in for the deprecated ``datetime.utcnow()``.

    Deliberately returns a **naive** datetime rather than an aware one.

    These timestamps round-trip through ``isoformat()`` / ``fromisoformat()``
    into ``~/.freecyto/layouts.json`` and ``experiments.json``, and files already
    on disk hold naive strings (no ``+00:00`` suffix). Switching to an aware
    ``datetime.now(timezone.utc)`` would start writing offset-suffixed strings
    and make freshly-created values incomparable with previously-stored ones
    (``TypeError: can't compare offset-naive and offset-aware datetimes``).

    ``datetime.utcnow()`` is deprecated and scheduled for removal; this keeps its
    exact semantics without the warning.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
