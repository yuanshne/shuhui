"""限流。

固定窗口计数，键里带上窗口序号，Redis 端只用 INCR + EXPIRE 两个命令：

    rl:{bucket}:{身份}:{窗口起点}

选固定窗口而不是滑动窗口，是因为它只要一次 INCR 就能判定，多实例之间
天然共享同一个计数器 —— 水平扩容后限流依然准确，这是放在进程内存里做不到的。
代价是窗口边界处允许瞬时两倍流量，对这里的场景（防脚本刷榜）足够。
"""
from __future__ import annotations

import threading
import time

from fastapi import HTTPException, Request, status


class RateLimiter:
    def __init__(self, redis_client=None) -> None:
        self._redis = redis_client
        self._mem: dict[str, int] = {}
        self._lock = threading.Lock()
        self.name = "redis" if redis_client is not None else "memory"

    def hit(self, key: str, limit: int, window: int) -> tuple[bool, int]:
        now = int(time.time())
        slot = now // window
        full = f"rl:{key}:{slot}"

        if self._redis is not None:
            try:
                pipe = self._redis.pipeline()
                pipe.incr(full)
                pipe.expire(full, window + 1)
                count = int(pipe.execute()[0])
                return count <= limit, max(limit - count, 0)
            except Exception:  # noqa: BLE001 - Redis 抖动时退到本地计数，不阻断业务
                pass

        with self._lock:
            # 顺手清理过期槽位，避免长期运行内存只涨不落
            if len(self._mem) > 4096:
                self._mem = {k: v for k, v in self._mem.items() if k.endswith(f":{slot}")}
            count = self._mem.get(full, 0) + 1
            self._mem[full] = count
        return count <= limit, max(limit - count, 0)


def client_identity(request: Request) -> str:
    """优先按用户，其次按 IP。反代后面拿 X-Forwarded-For 的第一跳。"""
    user = getattr(request.state, "user_id", None)
    if user:
        return f"u{user}"
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return f"ip{fwd.split(',')[0].strip()}"
    return f"ip{request.client.host if request.client else 'unknown'}"


def rate_limit(bucket: str, limit_attr: str, window_attr: str):
    """生成一个限流依赖。

    用法：dependencies=[Depends(rate_limit("auth", "rate_limit_auth", "auth_window"))]

    阈值这里传的是**配置项名字**而不是数值：数值会在导入时固化，
    测试换上临时配置就不生效了；传名字则每次请求读一次 app.state.settings。
    """

    def dependency(request: Request) -> None:
        settings = request.app.state.settings
        limit = int(getattr(settings, limit_attr))
        window = int(getattr(settings, window_attr))

        limiter: RateLimiter = request.app.state.limiter
        allowed, remaining = limiter.hit(
            f"{bucket}:{client_identity(request)}", limit, window
        )
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"请求过于频繁，请 {window} 秒后再试",
                headers={"Retry-After": str(window)},
            )
        request.state.rate_limit_remaining = remaining

    return dependency
