"""统计。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..clock import today_str
from ..db import get_db
from ..games import GAMES, get_game
from ..ratelimit import rate_limit
from ..schemas import GameStatsOut, OverviewOut
from ..services import count_users, game_stats

router = APIRouter(tags=["统计"])


@router.get(
    "/stats/overview",
    response_model=OverviewOut,
    summary="总览（首页用）",
    dependencies=[
        Depends(rate_limit("read", "rate_limit_read", "read_window"))
    ],
)
def overview(db: Session = Depends(get_db)) -> OverviewOut:
    return OverviewOut(
        games=[game_stats(db, spec) for spec in GAMES.values()],
        total_users=count_users(db),
        today=today_str(),
    )


@router.get(
    "/stats/{game}",
    response_model=GameStatsOut,
    summary="单款游戏的统计",
    dependencies=[
        Depends(rate_limit("read", "rate_limit_read", "read_window"))
    ],
)
def one_game(game: str, db: Session = Depends(get_db)) -> GameStatsOut:
    try:
        spec = get_game(game)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"未知游戏: {game}") from None
    return game_stats(db, spec)
