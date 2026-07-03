"""All money math. Integer minor units only — no floats anywhere in this path."""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_EVEN, InvalidOperation

# ISO 4217 exponents for the currencies in the demo data set.
EXPONENTS = {"USD": 2, "EUR": 2, "AUD": 2, "CAD": 2, "GBP": 2, "INR": 2, "JPY": 0}


def exponent(currency: str) -> int:
    return EXPONENTS.get(currency.upper(), 2)


def to_minor(value: str | Decimal, currency: str) -> int:
    """Parse a decimal string ('146.48') into integer minor units. Never float."""
    if isinstance(value, str):
        value = value.strip().lstrip("'")
        if value in ("", "-", "N/A"):
            return 0
        try:
            value = Decimal(value)
        except InvalidOperation:
            return 0
    e = exponent(currency)
    try:
        minor = int(value.quantize(Decimal(10) ** -e, rounding=ROUND_HALF_EVEN) * (10 ** e))
    except (InvalidOperation, OverflowError, ValueError):
        # e.g. '1e309' — quantize overflows; treat as unparseable rather than crash
        return 0
    # guard the downstream BIGINT column against out-of-range values
    if not (-(2 ** 63) <= minor < 2 ** 63):
        return 0
    return minor


def bps_of(amount_minor: int, bps: int) -> int:
    """basis-points fee on a minor-unit amount, banker's rounding."""
    return int(
        (Decimal(amount_minor) * Decimal(bps) / Decimal(10000)).quantize(
            Decimal(1), rounding=ROUND_HALF_EVEN
        )
    )


def fmt(amount_minor: int, currency: str) -> str:
    e = exponent(currency)
    d = Decimal(amount_minor) / (10 ** e)
    return f"{d:.{e}f}"
