"""排行榜查询。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from ..clock import parse_date, today_str
from ..deps import current_user_optional
from ..games import get_game
from ..leaderboard import board_key
from ..models import User
from ..ratelimit import rate_limit
from ..schemas import LeaderboardOut
from ..services import board_snapshot

router = APIRouter(prefix="/leaderboard", tags=["排行榜"])


@router.get(
    "/{game}",
    response_model=LeaderboardOut,
    summary="取榜单",
    description=(
        "scope=daily 取某一天的榜（默认今天）；scope=all 取历史总榜。"
        "榜上存的是个人最好成绩 —— 同一玩家多次交卷只留最快的那次。"
    ),
    dependencies=[
        Depends(rate_limit("read", "rate_limit_read", "read_window"))
    ],
)
def get_leaderboard(
    game: str,
    request: Request,
    variant: str | None = None,
    scope: str = Query("daily", pattern="^(daily|all)$"),
    date: str | None = None,
    limit: int = Query(20, ge=1, le=100),
) -> LeaderboardOut:
    try:
        spec = get_game(game)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"未知游戏: {game}") from None

    chosen = variant or spec.daily_default["variant"]
    if chosen not in spec.variants:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{game} 没有玩法 {chosen}，可选：{', '.join(spec.variants)}",
        )

    day: str | None = None
    if scope == "daily":
        day = date or today_str()
        try:
            parse_date(day)
        except ValueError:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, detail="date 需为 YYYY-MM-DD"
            ) from None

    backend = request.app.state.leaderboard
    entries, total = board_snapshot(backend, board_key(spec.id, chosen, day), limit)

    return LeaderboardOut(
        game=spec.id,
        variant=chosen,
        scope=scope,  # type: ignore[arg-type]
        date=day,
        backend=backend.name,
        total=total,
        entries=entries,
    )


@router.get(
    "/{game}/rank",
    summary="查我在榜上的位置",
    dependencies=[
        Depends(rate_limit("read", "rate_limit_read", "read_window"))
    ],
)
def my_rank(
    game: str,
    request: Request,
    variant: str | None = None,
    scope: str = Query("daily", pattern="^(daily|all)$"),
    date: str | None = None,
    user: User | None = Depends(current_user_optional),
) -> dict:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="需要登录")

    try:
        spec = get_game(game)
    except KeyError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=f"未知游戏: {game}") from None

    chosen = variant or spec.daily_default["variant"]
    day = (date or today_str()) if scope == "daily" else None

    backend = request.app.state.leaderboard
    key = board_key(spec.id, chosen, day)
    rank = backend.rank(key, user.username)
    if rank is None:
        return {"on_board": False, "rank": None, "total": backend.size(key)}

    rows = backend.top(key, rank + 1)
    score = float(rows[rank][1]) if rank < len(rows) else None
    return {
        "on_board": True,
        "rank": rank + 1,
        "total": backend.size(key),
        "elapsed_ms": int(score) if score is not None else None,
    }
