"""每日挑战的"一天"怎么算。

统一按东八区切日：服务器可能在 UTC、可能在别的时区，但"今天这道题"
必须是同一个概念，否则跨时区玩家会拿到不同题目。
"""
from __future__ import annotations

import re
from datetime import UTC, date, datetime, timedelta, timezone

from .config import get_settings

# strptime 对缺前导零是宽容的：datetime.strptime('2026-9-14', '%Y-%m-%d') 不报错。
# 但 "2026-9-14" 与 "2026-09-14" 是两条不同的字符串，拿它去查库必然查不到、
# 最后返回一个让人看不懂的 404。所以这里自己把格式卡死。
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def daily_tz() -> timezone:
    return timezone(timedelta(hours=get_settings().daily_tz_offset_hours))


def today_str(now: datetime | None = None) -> str:
    moment = now or datetime.now(UTC)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(daily_tz()).strftime("%Y-%m-%d")


def parse_date(value: str) -> date:
    if not isinstance(value, str) or not _DATE_RE.match(value):
        raise ValueError(f"日期应形如 YYYY-MM-DD，收到 {value!r}")
    return datetime.strptime(value, "%Y-%m-%d").date()


def day_start_utc(day: str) -> datetime:
    """该日 00:00（东八区）对应的 UTC 时刻。"""
    d = parse_date(day)
    local = datetime(d.year, d.month, d.day, tzinfo=daily_tz())
    return local.astimezone(UTC)


def day_end_utc(day: str) -> datetime:
    return day_start_utc(day) + timedelta(days=1)


def iter_recent_days(n: int, end: str | None = None) -> list[str]:
    last = parse_date(end or today_str())
    return [(last - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n - 1, -1, -1)]
