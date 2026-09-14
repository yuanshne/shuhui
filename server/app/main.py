"""应用工厂。

启动时做四件事，顺序有讲究：
  1. 建表
  2. 决定排行榜后端（Redis 连不上就降级内存）
  3. 起实时推送中枢（绑当前事件循环，否则同步接口没法往里推消息）
  4. 灌题池（幂等，每次启动都同步一遍，改题不用重启两次）
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import __version__
from .config import Settings, get_settings
from .db import build_engine, init_db, make_session_factory
from .games import GAMES
from .leaderboard import RedisBackend, build_backend
from .ratelimit import RateLimiter
from .realtime import LiveHub
from .routers import auth, daily, health, leaderboard, live, stats
from .seed import load_pool

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("shuhui-server")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def _make_limiter(leaderboard_backend) -> RateLimiter:
    """限流与排行榜共用一个 Redis 连接；用的是内存后端说明 Redis 不可用。"""
    if isinstance(leaderboard_backend, RedisBackend):
        return RateLimiter(leaderboard_backend.client)
    return RateLimiter(None)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = build_engine(settings.database_url)
        init_db(engine)
        app.state.engine = engine
        app.state.session_factory = make_session_factory(engine)

        app.state.settings = settings
        app.state.leaderboard = build_backend(settings)
        app.state.limiter = _make_limiter(app.state.leaderboard)

        hub = LiveHub(settings.redis_url, settings.ws_channel, settings.storage_mode)
        app.state.hub = hub
        # 同步接口要用 run_coroutine_threadsafe 把消息丢回来，必须先记住这个循环
        hub.bind_loop(asyncio.get_running_loop())
        await hub.start()

        pool = Path(settings.pool_file)
        if not settings.seed_on_startup:
            log.info("已跳过题池同步（seed_on_startup=False）")
        elif pool.exists():
            try:
                with app.state.session_factory() as db:
                    load_pool(db, pool)
            except Exception as exc:  # noqa: BLE001 - 题池坏了也要能把服务起起来
                log.error("题池载入失败（%s），服务将以空题库启动", exc)
        else:
            log.warning("未找到题池 %s，先跑 tools/gen_pool.mjs 生成", pool)

        log.info(
            "%s v%s 就绪 | 榜单=%s 实时=%s",
            settings.app_name,
            settings.version,
            app.state.leaderboard.name,
            hub.backend,
        )
        try:
            yield
        finally:
            await hub.stop()

    app = FastAPI(
        title="Puzzle Server",
        description=(
            "数织 / 数回 / 立方数独 / 长夜灯 四款网页游戏的统一后端。\n\n"
            "- 题面与答案分离，答案永不出现在任何出参里\n"
            "- 耗时由服务端计算，不采信客户端上报\n"
            "- 排行榜走 Redis ZSET，无 Redis 时自动降级进程内实现\n"
            "- WebSocket 推全量榜单快照"
        ),
        version=__version__,
        lifespan=lifespan,
        contact={"name": "yuanshne", "url": "https://github.com/yuanshne"},
        license_info={"name": "MIT"},
    )

    # 游戏前端可能跑在 GitHub Pages、localhost 或直接 file:// 打开，
    # 这里一律放行。用的是 Bearer 令牌而非 Cookie，不涉及跨站凭据。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(auth.router, prefix="/api/v1")
    app.include_router(daily.router, prefix="/api/v1")
    app.include_router(leaderboard.router, prefix="/api/v1")
    app.include_router(stats.router, prefix="/api/v1")
    app.include_router(live.router)

    @app.get("/", include_in_schema=False)
    def lobby():
        """极简大厅页：展示榜单与统计，也顺便当作接口的活文档。"""
        page = WEB_DIR / "index.html"
        if not page.exists():
            return JSONResponse(
                {
                    "service": settings.app_name,
                    "version": settings.version,
                    "docs": "/docs",
                    "games": list(GAMES.keys()),
                }
            )
        return FileResponse(page)

    return app


app = create_app()
