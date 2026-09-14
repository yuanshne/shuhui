"""跨路由复用的业务片段：榜单快照、耗时格式化、统计聚合。"""
from __future__ import annotations

from sqlalchemy import Integer, cast, func, select
from sqlalchemy.orm import Session

from .games import GAMES, GameSpec
from .leaderboard import LeaderboardBackend, board_key
from .models import Puzzle, Submission, User
from .schemas import GameStatsOut, LeaderboardEntry


def format_elapsed(ms: int) -> str:
    """毫秒 → 人看的耗时。不足一分钟用秒，超过用 mm:ss.t"""
    if ms is None:
        return "-"
    ms = max(int(ms), 0)
    total = ms / 1000.0
    minutes, seconds = divmod(total, 60)
    if minutes >= 1:
        return f"{int(minutes)}:{seconds:04.1f}"
    return f"{seconds:.1f}s"


def board_snapshot(
    backend: LeaderboardBackend, key: str, limit: int = 20
) -> tuple[list[LeaderboardEntry], int]:
    """取榜单前 N 名。并列同分同名次（取最好名次）。"""
    rows = backend.top(key, limit)
    entries: list[LeaderboardEntry] = []
    prev_score: float | None = None
    prev_rank = 0
    for idx, (member, score) in enumerate(rows, start=1):
        if prev_score is not None and score == prev_score:
            rank = prev_rank
        else:
            rank = idx
            prev_rank = rank
            prev_score = score
        entries.append(
            LeaderboardEntry(
                rank=rank,
                username=member,
                elapsed_ms=int(score),
                elapsed_text=format_elapsed(int(score)),
            )
        )
    return entries, backend.size(key)


def leaderboard_payload(
    spec: GameSpec,
    variant: str,
    scope: str,
    date: str | None,
    backend: LeaderboardBackend,
    limit: int = 20,
) -> dict:
    """给 WebSocket 用的推送体，与 REST 的 entries 结构保持一致。"""
    entries, total = board_snapshot(backend, board_key(spec.id, variant, date), limit)
    return {
        "type": "leaderboard",
        "game": spec.id,
        "variant": variant,
        "scope": scope,
        "date": date,
        "backend": backend.name,
        "total": total,
        "entries": [e.model_dump() for e in entries],
    }


def game_stats(db: Session, spec: GameSpec) -> GameStatsOut:
    """按游戏聚合：场次 / 答对 / 独立解出人数 / 最好与平均耗时 / 耗时分布。"""
    base = (
        select(
            func.count(Submission.id),
            func.sum(cast(Submission.correct, Integer)),
        )
        .join(Puzzle, Puzzle.id == Submission.puzzle_id)
        .where(Puzzle.game == spec.id)
    )
    plays, correct = db.execute(base).one()
    plays = int(plays or 0)
    correct = int(correct or 0)

    solvers = db.scalar(
        select(func.count(func.distinct(Submission.user_id)))
        .join(Puzzle, Puzzle.id == Submission.puzzle_id)
        .where(Puzzle.game == spec.id, Submission.correct.is_(True))
    )
    solvers = int(solvers or 0)

    agg = db.execute(
        select(func.min(Submission.elapsed_ms), func.avg(Submission.elapsed_ms))
        .join(Puzzle, Puzzle.id == Submission.puzzle_id)
        .where(
            Puzzle.game == spec.id,
            Submission.correct.is_(True),
            Submission.ranked.is_(True),
        )
    ).one()
    best_ms = int(agg[0]) if agg[0] is not None else None
    avg_ms = int(agg[1]) if agg[1] is not None else None

    # 耗时分布：六档，做前端柱状图用
    buckets = [
        ("<30s", 0, 30_000),
        ("30s-1m", 30_000, 60_000),
        ("1-3m", 60_000, 180_000),
        ("3-10m", 180_000, 600_000),
        ("10-30m", 600_000, 1_800_000),
        (">30m", 1_800_000, None),
    ]
    distribution: dict[str, int] = {}
    for label, lo, hi in buckets:
        cond = [Puzzle.game == spec.id, Submission.correct.is_(True), Submission.elapsed_ms >= lo]
        if hi is not None:
            cond.append(Submission.elapsed_ms < hi)
        n = db.scalar(
            select(func.count(Submission.id))
            .join(Puzzle, Puzzle.id == Submission.puzzle_id)
            .where(*cond)
        )
        distribution[label] = int(n or 0)

    return GameStatsOut(
        game=spec.id,
        game_name=spec.name,
        kind=spec.kind,
        plays=plays,
        correct=correct,
        solvers=solvers,
        best_ms=best_ms,
        avg_ms=avg_ms,
        distribution=distribution,
    )


def count_users(db: Session, *, include_guests: bool = False) -> int:
    stmt = select(func.count(User.id))
    if not include_guests:
        stmt = stmt.where(User.is_guest.is_(False))
    return int(db.scalar(stmt) or 0)


def all_puzzle_games() -> list[str]:
    return [g.id for g in GAMES.values()]
