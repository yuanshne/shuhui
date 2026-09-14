"""实时排行榜推送。

单进程时就是进程内的 WebSocket 集合；配了 Redis 之后多了一层 pub/sub：

    交卷 → PUBLISH puzzle:leaderboard → 每个 worker 各自 SUBSCRIBE → 推给自己的连接

于是"谁交卷"和"谁持有这个 WebSocket 连接"可以不在同一个进程。
只有一个 worker 时也走同一条路径（不留本地直推的分支），行为才是一致的。

publish 是从同步的接口函数里调用的，所以用 publish_threadsafe 把协程丢回事件循环。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging

from fastapi import WebSocket

log = logging.getLogger(__name__)


class LiveHub:
    def __init__(
        self,
        redis_url: str | None = None,
        channel: str = "puzzle:leaderboard",
        mode: str = "auto",
    ):
        self.redis_url = redis_url
        self.channel = channel
        self.mode = (mode or "auto").lower()
        self._topics: dict[str, set[WebSocket]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._redis = None
        self._sub = None
        self._task: asyncio.Task | None = None
        self.backend = "memory"

    # ---- 生命周期 ----

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def start(self) -> None:
        if self.mode == "memory" or not self.redis_url:
            return
        try:
            import redis.asyncio as aioredis

            self._redis = aioredis.from_url(self.redis_url, decode_responses=True)
            await self._redis.ping()
            self._sub = self._redis.pubsub()
            await self._sub.subscribe(self.channel)
            self._task = asyncio.create_task(self._listen())
            self.backend = "redis"
            log.info("实时推送后端: redis pub/sub (%s)", self.channel)
        except Exception as exc:  # noqa: BLE001
            if self.mode == "redis":
                raise RuntimeError(f"storage_mode=redis 但 pub/sub 不可用: {exc}") from exc
            log.warning("Redis pub/sub 不可用（%s），实时推送降级为进程内", exc)
            self._redis = None
            self._sub = None
            self.backend = "memory"

    async def stop(self) -> None:
        # 收尾一律"尽力而为"：某个连接关不掉不该影响其它连接的清理
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
        if self._sub is not None:
            with contextlib.suppress(Exception):
                await self._sub.unsubscribe(self.channel)
                await self._sub.aclose()
        if self._redis is not None:
            with contextlib.suppress(Exception):
                await self._redis.aclose()

    # ---- 连接管理 ----

    async def connect(self, topic: str, ws: WebSocket) -> None:
        await ws.accept()
        self._topics.setdefault(topic, set()).add(ws)

    async def disconnect(self, topic: str, ws: WebSocket) -> None:
        peers = self._topics.get(topic)
        if peers:
            peers.discard(ws)
            if not peers:
                self._topics.pop(topic, None)

    def connection_count(self, topic: str | None = None) -> int:
        if topic is None:
            return sum(len(v) for v in self._topics.values())
        return len(self._topics.get(topic) or ())

    # ---- 广播 ----

    async def publish(self, topic: str, message: dict) -> None:
        if self._redis is not None:
            await self._redis.publish(
                self.channel, json.dumps({"topic": topic, "message": message})
            )
            return
        await self._fanout(topic, message)

    def publish_threadsafe(self, topic: str, message: dict) -> None:
        """供同步接口调用。没有事件循环时静默跳过 —— 推送失败不该影响交卷结果。"""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with contextlib.suppress(RuntimeError):
            asyncio.run_coroutine_threadsafe(self.publish(topic, message), loop)

    async def _fanout(self, topic: str, message: dict) -> None:
        peers = list(self._topics.get(topic) or ())
        if not peers:
            return
        dead = []
        for ws in peers:
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 - 连接已断
                dead.append(ws)
        for ws in dead:
            await self.disconnect(topic, ws)

    async def _listen(self) -> None:
        assert self._sub is not None
        async for raw in self._sub.listen():
            if raw.get("type") != "message":
                continue
            try:
                envelope = json.loads(raw["data"])
            except (ValueError, TypeError):
                continue
            await self._fanout(envelope.get("topic", ""), envelope.get("message", {}))
