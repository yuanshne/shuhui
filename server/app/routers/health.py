"""健康检查。把三个外部依赖的状态都摊开，方便部署后一眼看出降级情况。"""
from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import text

from ..games import GAMES
from ..schemas import HealthOut

router = APIRouter(tags=["运维"])


@router.get("/health", response_model=HealthOut, summary="健康检查")
def health(request: Request) -> HealthOut:
    settings = request.app.state.settings

    try:
        with request.app.state.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        database = "ok"
    except Exception as exc:  # noqa: BLE001
        database = f"error: {type(exc).__name__}"

    hub = request.app.state.hub
    return HealthOut(
        status="ok" if database == "ok" else "degraded",
        version=settings.version,
        database=database,
        leaderboard=request.app.state.leaderboard.name,
        realtime=hub.backend,
        live_connections=hub.connection_count(),
        games=list(GAMES.keys()),
    )
