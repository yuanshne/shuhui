"""题池载入。这个环节挡住了"题池里混进坏题"，值得单独测。

坏题比没有题更糟：服务端拿它当真，玩家交对答案也会被判错。
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import func, select

from app.db import build_engine, init_db, make_session_factory
from app.models import Puzzle
from app.seed import PoolError, load_pool
from tests.conftest import POOL_PATH


@pytest.fixture()
def db(tmp_path):
    engine = build_engine(f"sqlite:///{(tmp_path / 'seed.db').as_posix()}")
    init_db(engine)
    with make_session_factory(engine)() as session:
        yield session


def write_pool(tmp_path, entries: list[dict]) -> str:
    path = tmp_path / "pool.json"
    path.write_text(json.dumps({"entries": entries}, ensure_ascii=False), encoding="utf-8")
    return str(path)


GOOD = {
    "game": "shuhui",
    "variant": "standard",
    "date": "2026-09-14",
    "difficulty": "normal",
    "payload": {"n": 2, "clue": [[2, 2], [2, 2]]},
    "solution": {"on": [0, 1, 4, 5, 6, 8, 9, 11]},
}


def test_loads_and_is_idempotent(db, tmp_path):
    path = write_pool(tmp_path, [GOOD])
    first = load_pool(db, path)
    assert first == {"inserted": 1, "updated": 0}

    second = load_pool(db, path)
    assert second == {"inserted": 0, "updated": 1}
    assert db.scalar(select(func.count(Puzzle.id))) == 1


def test_reloading_updates_the_puzzle_in_place(db, tmp_path):
    """重新灌池要能覆盖旧题，而不是拒绝或重复插入。"""
    path = write_pool(tmp_path, [GOOD])
    load_pool(db, path)

    # 换一道自洽的题：全填满，行列线索都是 [3]
    improved = {
        "game": "shuhui",
        "variant": "standard",
        "date": "2026-09-14",
        "difficulty": "hard",
        "payload": {"n": 2, "clue": [[2, 2], [2, 2]]},
        "solution": {"on": [0, 1, 4, 5, 6, 8, 9, 11]},
    }
    load_pool(db, write_pool(tmp_path, [improved]))

    row = db.scalar(select(Puzzle))
    db.refresh(row)
    assert row.payload["clue"] == [[2, 2], [2, 2]]
    assert row.solution["on"] == [0, 1, 4, 5, 6, 8, 9, 11]
    assert row.difficulty == "hard"
    assert db.scalar(select(func.count(Puzzle.id))) == 1


def test_missing_file_raises(db, tmp_path):
    with pytest.raises(PoolError):
        load_pool(db, tmp_path / "nope.json")


@pytest.mark.parametrize(
    "mutate, needle",
    [
        (lambda e: e.pop("date"), "缺少字段"),
        (lambda e: e.update(game="nope"), "未知游戏"),
        (lambda e: e.update(variant="nope"), "没有玩法"),
        (lambda e: e.update(date="2026/09/14"), "日期格式"),
        (lambda e: e.update(payload="x"), "必须是对象"),
        (lambda e: e.update(solution="x"), "必须是对象"),
    ],
)
def test_malformed_entries_are_rejected(db, tmp_path, mutate, needle):
    entry = json.loads(json.dumps(GOOD))
    mutate(entry)
    with pytest.raises(PoolError) as exc:
        load_pool(db, write_pool(tmp_path, [entry]))
    assert needle in str(exc.value)


def test_puzzle_and_solution_must_agree(db, tmp_path):
    """题面与答案各说各话时必须在灌池阶段就炸掉。"""
    entry = json.loads(json.dumps(GOOD))
    entry["solution"] = {"on": [0, 1, 4, 5, 6, 8, 9]}  # 抽掉一条边，回路断裂
    with pytest.raises(PoolError) as exc:
        load_pool(db, write_pool(tmp_path, [entry]))
    assert "不是一条回路" in str(exc.value)


def test_real_pool_loads_completely(db):
    """仓库里那份真题池必须整份灌得进去。"""
    stats = load_pool(db, POOL_PATH)
    assert stats["inserted"] > 0
    assert stats["updated"] == 0

    total = db.scalar(select(func.count(Puzzle.id)))
    assert total == stats["inserted"]

    games = {row for (row,) in db.execute(select(Puzzle.game).distinct())}
    assert games == {"shuhui"}

    # 每天每组合恰好一道题
    duplicates = db.execute(
        select(Puzzle.game, Puzzle.variant, Puzzle.puzzle_date, func.count(Puzzle.id))
        .group_by(Puzzle.game, Puzzle.variant, Puzzle.puzzle_date)
        .having(func.count(Puzzle.id) > 1)
    ).all()
    assert duplicates == []
