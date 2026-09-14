"""接口出入参模型。

题面（puzzle）刻意声明为自由 dict：四款游戏的题面结构完全不同，
在这里穷举它们的字段只会让新增游戏时到处都要改。契约由 app/games.py 定义。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

USERNAME_PATTERN = r"^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$"


# ---------------------------------------------------------------- 鉴权

class RegisterIn(BaseModel):
    username: str = Field(..., min_length=2, max_length=20)
    password: str = Field(..., min_length=6, max_length=128)
    # 游客账号也走注册，但默认不进榜单
    guest: bool = False

    @field_validator("username")
    @classmethod
    def _check_username(cls, v: str) -> str:
        import re

        if not re.match(USERNAME_PATTERN, v):
            raise ValueError("用户名只能包含中英文、数字与下划线，长度 2~20")
        return v


class LoginIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=20)
    password: str = Field(..., min_length=1, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    is_guest: bool
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut


# ---------------------------------------------------------------- 每日题

class DailyOut(BaseModel):
    puzzle_id: int
    game: str
    game_name: str
    variant: str
    difficulty: str
    date: str
    # 题面结构随游戏而异，见 app/games.py
    puzzle: dict[str, Any]
    # 只有登录用户才有服务端开工时刻（用于服务端计时）
    started_at: datetime | None = None
    expires_at: datetime | None = None
    timed: bool = False


class SubmitIn(BaseModel):
    puzzle_id: int
    solution: dict[str, Any]


class SubmitOut(BaseModel):
    correct: bool
    message: str
    # 以下字段只对登录用户且有榜单的游戏有意义
    ranked: bool = False
    elapsed_ms: int | None = None
    rank: int | None = None
    total: int | None = None
    personal_best_ms: int | None = None
    improved: bool = False


# ---------------------------------------------------------------- 榜单

class LeaderboardEntry(BaseModel):
    rank: int
    username: str
    elapsed_ms: int
    elapsed_text: str


class LeaderboardOut(BaseModel):
    game: str
    variant: str
    scope: Literal["daily", "all"]
    date: str | None
    backend: str
    total: int
    entries: list[LeaderboardEntry]


# ---------------------------------------------------------------- 统计

class GameStatsOut(BaseModel):
    game: str
    game_name: str
    kind: str
    plays: int
    correct: int
    solvers: int
    best_ms: int | None
    avg_ms: int | None
    distribution: dict[str, int] = Field(default_factory=dict)


class OverviewOut(BaseModel):
    games: list[GameStatsOut]
    total_users: int
    today: str


# ---------------------------------------------------------------- 事件

class HealthOut(BaseModel):
    status: str
    version: str
    database: str
    leaderboard: str
    realtime: str
    live_connections: int
    games: list[str]
