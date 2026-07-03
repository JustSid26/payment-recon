"""Business-day calendar for T+N settlement timing.

The gateway is Cyprus-domiciled, so settlement dates skip weekends and Cyprus
public holidays. `next_settlement_datetime(captured_at, delay_days)` returns the
instant a capture becomes eligible to settle: the start (00:00 UTC) of the date
that is `delay_days` business days after the capture's date. T+1 == delay_days=1
== "next business day".
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

# Cyprus public holidays in the platform's operating window. Fixed-date holidays
# and the 2026 Orthodox movable feasts; extend per year as needed. A date in a
# year not listed simply falls back to weekend-only skipping.
_CY_HOLIDAYS: set[date] = {
    date(2026, 1, 1),    # New Year's Day
    date(2026, 1, 6),    # Epiphany
    date(2026, 2, 23),   # Green Monday (Orthodox)
    date(2026, 3, 25),   # Greek Independence Day
    date(2026, 4, 1),    # Cyprus National Day
    date(2026, 4, 10),   # Orthodox Good Friday
    date(2026, 4, 13),   # Orthodox Easter Monday
    date(2026, 5, 1),    # Labour Day
    date(2026, 6, 1),    # Orthodox Whit Monday (Kataklysmos-adjacent)
    date(2026, 8, 15),   # Assumption
    date(2026, 10, 1),   # Cyprus Independence Day
    date(2026, 10, 28),  # Ohi Day
    date(2026, 12, 25),  # Christmas Day
    date(2026, 12, 26),  # Boxing Day
}


def is_business_day(d: date) -> bool:
    return d.weekday() < 5 and d not in _CY_HOLIDAYS


def add_business_days(d: date, n: int) -> date:
    """d + n business days. n<=0 rolls forward to the nearest business day."""
    if n <= 0:
        while not is_business_day(d):
            d += timedelta(days=1)
        return d
    while n > 0:
        d += timedelta(days=1)
        if is_business_day(d):
            n -= 1
    return d


def next_settlement_datetime(captured_at: datetime, delay_days: int = 1) -> datetime:
    """Eligible instant for a capture: 00:00 UTC of its settlement date."""
    base = captured_at.astimezone(timezone.utc).date()
    settle_date = add_business_days(base, delay_days)
    return datetime.combine(settle_date, time(0, 0), tzinfo=timezone.utc)
