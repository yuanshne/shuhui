"""把 tools/gen_pool.mjs 生成的题池灌进数据库。

幂等：同 (game, variant, date) 已存在就更新题面与答案，不新增行。
所以重新灌池可以安全地用新题覆盖旧题，不会把用户的历史提交搞乱。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .clock import parse_date
from .consistency import InconsistentPuzzle, check_consistency
from .games import get_game
from .models import Puzzle

log = logging.getLogger(__name__)


class PoolError(ValueError):
    """题池文件本身有问题。"""


def _check_entry(entry: dict) -> None:
    for key in ("game", "variant", "date", "payload", "solution"):
        if key not in entry:
            raise PoolError(f"题池条目缺少字段 {key}: {entry!r}")

    game = entry["game"]
    try:
        spec = get_game(game)
    except KeyError:
        raise PoolError(f"题池里出现未知游戏: {game}") from None

    if entry["variant"] not in spec.variants:
        raise PoolError(f"{game} 没有玩法 {entry['variant']}")

    try:
        parse_date(entry["date"])
    except ValueError:
        raise PoolError(f"日期格式应为 YYYY-MM-DD，收到 {entry['date']!r}") from None

    if not isinstance(entry["payload"], dict) or not isinstance(entry["solution"], dict):
        raise PoolError(f"{game} {entry['date']} 的题面/答案必须是对象")

    # 题面与答案必须真的配得上。
    # 注意别用"拿答案当交卷再校验一次"来充当自检 —— 那等于拿答案跟自己比，
    # 恒为真，连"线索和答案毫不相干"都发现不了。
    try:
        check_consistency(game, entry["payload"], entry["solution"])
    except InconsistentPuzzle as exc:
        raise PoolError(f"{game} {entry['date']} 题面与答案不匹配：{exc}") from exc


def load_pool(db: Session, path: str | Path) -> dict[str, int]:
    path = Path(path)
    if not path.exists():
        raise PoolError(f"题池文件不存在: {path}")

    raw = json.loads(path.read_text(encoding="utf-8"))
    entries = raw["entries"] if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        raise PoolError("题池文件应为列表，或含 entries 数组的对象")

    stats = {"inserted": 0, "updated": 0}
    for entry in entries:
        _check_entry(entry)

        row = db.scalar(
            select(Puzzle).where(
                Puzzle.game == entry["game"],
                Puzzle.variant == entry["variant"],
                Puzzle.puzzle_date == entry["date"],
            )
        )
        difficulty = entry.get("difficulty") or get_game(entry["game"]).daily_default["difficulty"]
        if row is None:
            db.add(
                Puzzle(
                    game=entry["game"],
                    variant=entry["variant"],
                    puzzle_date=entry["date"],
                    difficulty=difficulty,
                    payload=entry["payload"],
                    solution=entry["solution"],
                )
            )
            stats["inserted"] += 1
        else:
            row.payload = entry["payload"]
            row.solution = entry["solution"]
            row.difficulty = difficulty
            stats["updated"] += 1
    db.commit()

    log.info("题池载入完成: 新增 %d，更新 %d", stats["inserted"], stats["updated"])
    return stats
