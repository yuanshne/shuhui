"""排行榜存储。

两个实现共用一套接口：

    RedisBackend   ZSET，按耗时升序排名，天然 O(log n)，多进程共享
    MemoryBackend  进程内字典，没有 Redis 时自动降级，单机开发/测试用

为什么是 ZADD ... LT：只要"个人最好成绩"进榜，同一玩家多次交卷只保留更快的
那次。LT 让 Redis 端原子地完成"仅在更优时更新"，不需要读-改-写。
"""
from __future__ import annotations

import logging
import threading
from typing import Protocol

from .config import Settings

log = logging.getLogger(__name__)

ALL_TIME = "all"


def board_key(game: str, variant: str, puzzle_date: str | None) -> str:
    """榜单键。puzzle_date=None 表示历史总榜。"""
    return f"lb:{game}:{variant}:{puzzle_date or ALL_TIME}"


class LeaderboardBackend(Protocol):
    name: str

    def record(self, key: str, member: str, score: float) -> None: ...
    def rank(self, key: str, member: str) -> int | None: ...
    def top(self, key: str, limit: int) -> list[tuple[str, float]]: ...
    def size(self, key: str) -> int: ...
    def clear(self, key: str | None = None) -> None: ...


class MemoryBackend:
    """进程内实现。单测与无 Redis 环境使用。"""

    name = "memory"

    def __init__(self) -> None:
        self._boards: dict[str, dict[str, float]] = {}
        self._lock = threading.Lock()

    def record(self, key: str, member: str, score: float) -> None:
        with self._lock:
            board = self._boards.setdefault(key, {})
            cur = board.get(member)
            if cur is None or score < cur:
                board[member] = score

    def rank(self, key: str, member: str) -> int | None:
        with self._lock:
            board = self._boards.get(key) or {}
            if member not in board:
                return None
            score = board[member]
            better = sum(1 for v in board.values() if v < score)
            return better  # 0-based，与其他并列时取最好名次

    def top(self, key: str, limit: int) -> list[tuple[str, float]]:
        with self._lock:
            board = self._boards.get(key) or {}
            items = sorted(board.items(), key=lambda kv: (kv[1], kv[0]))
        return [(m, s) for m, s in items[:limit]]

    def size(self, key: str) -> int:
        with self._lock:
            return len(self._boards.get(key) or {})

    def clear(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._boards.clear()
            else:
                self._boards.pop(key, None)


class RedisBackend:
    """ZSET 实现。"""

    name = "redis"

    def __init__(self, client) -> None:
        self.client = client

    def record(self, key: str, member: str, score: float) -> None:
        # lt=True：已存在且更快时不覆盖；不存在则直接加入
        self.client.zadd(key, {member: score}, lt=True)

    def rank(self, key: str, member: str) -> int | None:
        rank = self.client.zrank(key, member)
        return None if rank is None else int(rank)

    def top(self, key: str, limit: int) -> list[tuple[str, float]]:
        rows = self.client.zrange(key, 0, max(limit - 1, 0), withscores=True)
        return [(m.decode() if isinstance(m, bytes) else m, float(s)) for m, s in rows]

    def size(self, key: str) -> int:
        return int(self.client.zcard(key))

    def clear(self, key: str | None = None) -> None:
        if key is None:
            for k in self.client.scan_iter("lb:*"):
                self.client.delete(k)
        else:
            self.client.delete(key)


CONNECT_TIMEOUT = 0.25


def build_backend(settings: Settings) -> LeaderboardBackend:
    """按 storage_mode 决定用哪套实现。

    auto 模式下 Redis 连不上就降级内存并留一条日志 —— 本地开发、CI、
    没装 Redis 的机器上服务必须照样能起来，不能因为一个可选依赖起不来。
    """
    mode = (settings.storage_mode or "auto").lower()
    if mode == "memory":
        log.info("排行榜后端: memory（storage_mode=memory）")
        return MemoryBackend()

    url = settings.redis_url or "redis://localhost:6379/0"
    try:
        import redis

        client = redis.Redis.from_url(
            url,
            decode_responses=False,
            socket_connect_timeout=CONNECT_TIMEOUT,
            socket_timeout=CONNECT_TIMEOUT,
        )
        client.ping()
        log.info("排行榜后端: redis (%s)", url)
        return RedisBackend(client)
    except Exception as exc:  # noqa: BLE001 - 任何连接问题都算连不上
        if mode == "redis":
            raise RuntimeError(
                f"storage_mode=redis 但连不上 {url}: {exc}"
            ) from exc
        log.warning("Redis 不可用（%s），排行榜降级为进程内实现", exc)
        return MemoryBackend()
