"""校验器单元测试：不经过 HTTP，直接打 app/games.py。

重点是"格式错误"与"答错"必须区分开 —— 前者 400、后者 200。
"""
from __future__ import annotations

import pytest

from app.games import GAMES, ValidationError, get_game
from tests.conftest import GAME

# ------------------------------------------------------------------ 数回

SHUHUI_PAYLOAD = {"n": 2, "clue": [[-1, -1], [-1, -1]]}


def test_shuhui_edge_set_is_order_independent():
    """交卷的边序不该影响判定 —— 玩家划线顺序是随机的。"""
    solution = {"on": [0, 1, 4, 5]}
    spec = get_game(GAME)
    assert spec.check(SHUHUI_PAYLOAD, solution, {"on": [0, 1, 4, 5]}) is True
    assert spec.check(SHUHUI_PAYLOAD, solution, {"on": [5, 0, 4, 1]}) is True
    # 重复报同一条边也应视为等价（集合语义）
    assert spec.check(SHUHUI_PAYLOAD, solution, {"on": [0, 0, 1, 1, 4, 5]}) is True


def test_shuhui_rejects_missing_or_extra_edges():
    solution = {"on": [0, 1, 4, 5]}
    spec = get_game(GAME)
    assert spec.check(SHUHUI_PAYLOAD, solution, {"on": [0, 1, 4]}) is False
    assert spec.check(SHUHUI_PAYLOAD, solution, {"on": [0, 1, 4, 5, 6]}) is False


def test_shuhui_out_of_range_edge_is_format_error():
    with pytest.raises(ValidationError):
        get_game(GAME).check(SHUHUI_PAYLOAD, {"on": []}, {"on": [999]})
    with pytest.raises(ValidationError):
        get_game(GAME).check(SHUHUI_PAYLOAD, {"on": []}, {"on": ["x"]})


# ------------------------------------------------------------------ 注册表

# ------------------------------------------------------------------ 注册表

def test_registry_is_self_consistent():
    assert set(GAMES) == {"shuhui"}
    for spec in GAMES.values():
        assert spec.id in GAMES
        assert spec.daily_default["variant"] in spec.variants
        assert spec.daily_default["difficulty"] in spec.difficulties
        assert spec.accent.startswith("#")


def test_unknown_game_raises():
    with pytest.raises(KeyError):
        get_game("nope")
