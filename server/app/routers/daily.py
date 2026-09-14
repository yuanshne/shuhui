"""每日挑战：取题、交卷。

三条设计原则：

1. 答案只留在服务端。出参里只有题面，客户端永远拿不到解。
2. 计时在服务端。领题时记 started_at，交卷时算差值 —— 客户端上报的时间一律不采信。
3. 交卷格式非法（400）与答错（200 correct=false）是两回事，不能都算作"失败"。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..clock import day_end_utc, parse_date, today_str
from ..db import get_db
from ..deps import current_user_optional
from ..games import ValidationError, get_game
from ..leaderboard import board_key
from ..models import DailySession, Puzzle, Submission, User, utcnow
from ..ratelimit import rate_limit
from ..schemas import DailyOut, SubmitIn, SubmitOut
from ..services import format_elapsed, leaderboard_payload

router = APIRouter(prefix="/daily", tags=["每日挑战"])


def _spec_or_404(game: str):
    try:
        return get_game(game)
    except KeyError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f"未知游戏: {game}"
        ) from None


@router.get(
    "/{game}",
    response_model=DailyOut,
    summary="取当日题目",
    description=(
        "同一天、同一玩法的题目全球一致。登录用户会同时开一次服务端计时；"
        "游客可自由练习，但成绩不进榜单。"
    ),
    dependencies=[
        Depends(rate_limit("read", "rate_limit_read", "read_window"))
    ],
)
def get_daily(
    game: str,
    variant: str | None = None,
    date: str | None = None,
    user: User | None = Depends(current_user_optional),
    db: Session = Depends(get_db),
) -> DailyOut:
    spec = _spec_or_404(game)

    day = date or today_str()
    try:
        parse_date(day)
    except ValueError:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="date 需为 YYYY-MM-DD"
        ) from None

    chosen = variant or spec.daily_default["variant"]
    if chosen not in spec.variants:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{game} 没有玩法 {chosen}，可选：{', '.join(spec.variants)}",
        )

    puzzle = db.scalar(
        select(Puzzle).where(
            Puzzle.game == game,
            Puzzle.variant == chosen,
            Puzzle.puzzle_date == day,
        )
    )
    if puzzle is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"{day} 的题目还没生成（题池需要先灌 data/pool.json）",
        )

    started = None
    if user is not None:
        session = db.scalar(
            select(DailySession).where(
                DailySession.user_id == user.id, DailySession.puzzle_id == puzzle.id
            )
        )
        if session is None:
            session = DailySession(user_id=user.id, puzzle_id=puzzle.id, started_at=utcnow())
            db.add(session)
            db.commit()
        started = session.started_at

    return DailyOut(
        puzzle_id=puzzle.id,
        game=game,
        game_name=spec.name,
        variant=chosen,
        difficulty=puzzle.difficulty,
        date=day,
        puzzle=puzzle.payload,
        started_at=started,
        expires_at=day_end_utc(day).replace(tzinfo=None),
        timed=started is not None,
    )


@router.post(
    "/{game}/submit",
    response_model=SubmitOut,
    summary="交卷",
    description="答案由服务端校验；耗时按服务端记的领题时刻计算。",
    dependencies=[
        Depends(rate_limit("submit", "rate_limit_submit", "submit_window"))
    ],
)
def submit(
    game: str,
    body: SubmitIn,
    request: Request,
    user: User | None = Depends(current_user_optional),
    db: Session = Depends(get_db),
) -> SubmitOut:
    spec = _spec_or_404(game)
    if spec.kind == "narrative":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="叙事类游戏没有判分，请改用 POST /events/{game} 上报进度",
        )

    puzzle = db.get(Puzzle, body.puzzle_id)
    if puzzle is None or puzzle.game != game:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="题目不存在")

    try:
        correct = spec.check(puzzle.payload, puzzle.solution, body.solution)
    except ValidationError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, detail=f"交卷格式有误：{exc}"
        ) from exc

    if not correct:
        if user is not None:
            _record(db, user, puzzle, correct=False, elapsed_ms=0, ranked=False,
                    reason="wrong")
        return SubmitOut(correct=False, message="答案不对，再试试")

    if user is None:
        return SubmitOut(correct=True, message="答对了！登录后成绩才能进榜单")

    # ---- 服务端计时 ----
    settings = request.app.state.settings
    session = db.scalar(
        select(DailySession).where(
            DailySession.user_id == user.id, DailySession.puzzle_id == puzzle.id
        )
    )
    now = utcnow()
    started = session.started_at if session is not None else now
    elapsed_ms = int((now - started).total_seconds() * 1000)

    reason: str | None = None
    if user.is_guest:
        reason = "guest"
    elif elapsed_ms < settings.min_elapsed_ms:
        reason = "too_fast"
    elif elapsed_ms > settings.max_elapsed_ms:
        reason = "expired"

    ranked = reason is None

    # 先读旧的最好成绩，再落库 —— 反过来的话刚写进去的这条就成了"历史最好"，
    # improved 永远是 False。
    previous_best = _personal_best(db, user.id, puzzle.id)

    _record(db, user, puzzle, correct=True, elapsed_ms=elapsed_ms, ranked=ranked,
            reason=reason)

    if session is not None:
        session.finished_at = now
        db.commit()

    improved = previous_best is None or elapsed_ms < previous_best
    best_after = elapsed_ms if improved else previous_best

    if not ranked:
        hints = {
            "guest": "答对了！游客成绩不进榜单，注册一个账号即可上榜",
            "too_fast": f"答对了，但耗时 {format_elapsed(elapsed_ms)} 低于下限，本次不计入榜单",
            "expired": "答对了，但已超出计时窗口，本次不计入榜单",
        }
        return SubmitOut(
            correct=True,
            message=hints.get(reason or "", "答对了"),
            ranked=False,
            elapsed_ms=elapsed_ms,
            personal_best_ms=previous_best,
        )

    # ---- 上榜 ----
    backend = request.app.state.leaderboard
    keys = [
        board_key(spec.id, puzzle.variant, puzzle.puzzle_date),  # 当日榜
        board_key(spec.id, puzzle.variant, None),                # 历史总榜
    ]
    rank = total = None
    for key in keys:
        backend.record(key, user.username, float(elapsed_ms))
    rank = backend.rank(keys[0], user.username)
    total = backend.size(keys[0])

    # 实时推送：只推当日榜
    request.app.state.hub.publish_threadsafe(
        f"leaderboard:{spec.id}:{puzzle.variant}",
        leaderboard_payload(spec, puzzle.variant, "daily", puzzle.puzzle_date, backend),
    )

    rank_text = f"第 {rank + 1} 名" if rank is not None else "已上榜"
    return SubmitOut(
        correct=True,
        message=f"答对了！用时 {format_elapsed(elapsed_ms)}，当前{rank_text} / 共 {total} 人",
        ranked=True,
        elapsed_ms=elapsed_ms,
        rank=(rank + 1) if rank is not None else None,
        total=total,
        personal_best_ms=best_after,
        improved=improved,
    )


# ---------------------------------------------------------------- 内部

def _record(
    db: Session,
    user: User,
    puzzle: Puzzle,
    *,
    correct: bool,
    elapsed_ms: int,
    ranked: bool,
    reason: str | None,
) -> None:
    db.add(
        Submission(
            user_id=user.id,
            puzzle_id=puzzle.id,
            correct=correct,
            elapsed_ms=elapsed_ms,
            ranked=ranked,
            reject_reason=reason,
        )
    )
    db.commit()


def _personal_best(db: Session, user_id: int, puzzle_id: int) -> int | None:
    value = db.scalar(
        select(func.min(Submission.elapsed_ms)).where(
            Submission.user_id == user_id,
            Submission.puzzle_id == puzzle_id,
            Submission.correct.is_(True),
            Submission.ranked.is_(True),
        )
    )
    return int(value) if value is not None else None
