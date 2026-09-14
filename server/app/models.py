"""数据模型。

设计取舍：
- 排行榜不落库（放 Redis ZSET），库里只留"发生了什么"的事实表，
  这样榜单可以随时重建，也避免高频写入打爆 SQLite 的写锁。
- 题目答案与题面同表不同列：题面发客户端，答案只在服务端参与校验。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    """朴素 UTC（不带 tzinfo）。

    SQLite 不保存时区：存进去是 aware datetime，读回来 tzinfo 就没了，
    再拿来相减会抛 "can't subtract offset-naive and offset-aware"。
    全库统一用朴素 UTC，比较和序列化都不踩这个坑。
    """
    return datetime.now(UTC).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(128))
    # 匿名访客也建号（用户名形如 guest_xxxx），但不出现在榜单上
    is_guest: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    submissions: Mapped[list[Submission]] = relationship(back_populates="user")


class Puzzle(Base):
    """一道每日题。题池由 tools/gen_pool.mjs 预生成后灌入。"""

    __tablename__ = "puzzles"
    __table_args__ = (
        UniqueConstraint("game", "variant", "puzzle_date", name="uq_puzzle_slot"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    game: Mapped[str] = mapped_column(String(24), index=True)
    variant: Mapped[str] = mapped_column(String(24), default="default")
    puzzle_date: Mapped[str] = mapped_column(String(10), index=True)  # YYYY-MM-DD
    difficulty: Mapped[str] = mapped_column(String(16), default="normal")

    # 发给客户端的题面
    payload: Mapped[dict] = mapped_column(JSON)
    # 只在服务端使用的答案（不经过任何出参序列化）
    solution: Mapped[dict] = mapped_column(JSON)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Submission(Base):
    """一次交卷记录。正确与否、耗时、是否计入榜单都在这里留痕。"""

    __tablename__ = "submissions"
    __table_args__ = (
        Index("ix_submission_user_puzzle", "user_id", "puzzle_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    puzzle_id: Mapped[int] = mapped_column(
        ForeignKey("puzzles.id", ondelete="CASCADE"), index=True
    )

    correct: Mapped[bool] = mapped_column(Boolean, default=False)
    # 服务端算出的耗时（客户端不上报时间，避免伪造）
    elapsed_ms: Mapped[int] = mapped_column(Integer, default=0)
    ranked: Mapped[bool] = mapped_column(Boolean, default=False)
    reject_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)

    user: Mapped[User] = relationship(back_populates="submissions")


class DailySession(Base):
    """玩家在某一天领了某道题 → 记下服务端开工时刻，用于算真实耗时。"""

    __tablename__ = "daily_sessions"
    __table_args__ = (
        UniqueConstraint("user_id", "puzzle_id", name="uq_session_user_puzzle"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    puzzle_id: Mapped[int] = mapped_column(ForeignKey("puzzles.id", ondelete="CASCADE"))
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
