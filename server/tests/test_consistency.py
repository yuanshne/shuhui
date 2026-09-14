"""题面自洽性校验。

这一层的价值全在"能抓出真问题"上，所以测试里故意构造各种题面与答案对不上的情况。
"""
from __future__ import annotations

import pytest

from app.consistency import InconsistentPuzzle, check_consistency
from tests.conftest import GAME

# ------------------------------------------------------------------ 本游戏

# ------------------------------------------------------------------ 数回

def _square_loop(n: int = 2) -> list[int]:
    """n×n 盘面最外圈构成的回路。

    编号约定：H(r,c) → r*n+c；V(r,c) → n*(n+1)+r*(n+1)+c。
    n=2 时得到 8 条边，每格恰好被 2 条边围住，所以线索应全为 2。
    """
    h_count = n * (n + 1)
    edges = []
    edges += [0 * n + c for c in range(n)]              # 上：H(0,c)
    edges += [n * n + c for c in range(n)]              # 下：H(n,c)
    edges += [h_count + r * (n + 1) + 0 for r in range(n)]  # 左：V(r,0)
    edges += [h_count + r * (n + 1) + n for r in range(n)]  # 右：V(r,n)
    return edges


ALL_TWO = [[2, 2], [2, 2]]  # n=2 最外圈对应的线索


def test_valid_loop_passes():
    payload = {"n": 2, "clue": ALL_TWO}
    check_consistency(GAME, payload, {"on": _square_loop(2)})


def test_broken_loop_is_caught():
    """抽掉一条边 → 出现两个度数为 1 的端点。"""
    edges = _square_loop(2)[:-1]
    with pytest.raises(InconsistentPuzzle) as exc:
        check_consistency(GAME, {"n": 2, "clue": ALL_TWO}, {"on": edges})
    assert "不是一条回路" in str(exc.value)


def test_two_separate_loops_are_caught():
    """两个互不相接的小环 —— 各自度数都合法，但不是一条回路。

    用 3×3 盘面，让两个 1×1 环分别待在左上角和右下角（2×2 里它们必然会
    共用中心点，那会先被"度数必须为 2"拦下，测不到连通性这条）。
    """
    n = 3
    h_count = n * (n + 1)
    top_left = [0 * n + 0, 1 * n + 0, h_count + 0 * (n + 1) + 0, h_count + 0 * (n + 1) + 1]
    bottom_right = [2 * n + 2, 3 * n + 2, h_count + 2 * (n + 1) + 2, h_count + 2 * (n + 1) + 3]
    clue = [[-1] * n for _ in range(n)]
    with pytest.raises(InconsistentPuzzle) as exc:
        check_consistency(GAME, {"n": n, "clue": clue}, {"on": top_left + bottom_right})
    assert "不连通" in str(exc.value)


def test_edge_out_of_range_is_caught():
    with pytest.raises(InconsistentPuzzle) as exc:
        check_consistency(GAME, {"n": 2, "clue": ALL_TWO}, {"on": [999]})
    assert "越界" in str(exc.value)


def test_empty_solution_is_caught():
    with pytest.raises(InconsistentPuzzle):
        check_consistency(GAME, {"n": 2, "clue": ALL_TWO}, {"on": []})


def test_clue_mismatch_is_caught():
    """回路本身没问题，但格里的数字写得不对。"""
    clue = [[3, 2], [2, 2]]
    with pytest.raises(InconsistentPuzzle) as exc:
        check_consistency(GAME, {"n": 2, "clue": clue}, {"on": _square_loop(2)})
    assert "线索是 3" in str(exc.value)


def test_wrong_clue_grid_shape_is_caught():
    with pytest.raises(InconsistentPuzzle):
        check_consistency(GAME, {"n": 2, "clue": [[-1]]}, {"on": _square_loop(2)})


def test_repeated_edge_is_deduplicated():
    """同一条边报两次不该被当成两条 —— 集合语义。"""
    edges = _square_loop(2)
    check_consistency(GAME, {"n": 2, "clue": ALL_TWO}, {"on": edges + edges})



# ------------------------------------------------------------------ 未注册的游戏

# ------------------------------------------------------------------ 未注册的游戏

def test_unregistered_game_is_skipped():
    """注册表里没有的游戏不做检查，交给上层决定怎么处理。"""
    check_consistency("nonexistent", {"x": 1}, {"y": 2})
