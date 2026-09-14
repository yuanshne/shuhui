"""题面自洽性校验：答案必须真的能解出这个题面。

和 app/games.py 的分工：
    games.py        玩家交上来的答案，对不对
    consistency.py  题池里的题面与答案，配不配

为什么必须单独做这一层：只"拿答案跟答案自己比"是永远成立的，
那种自检连"线索和答案毫不相干"都发现不了。这里改成从答案反推线索，
再跟题面里写的线索对比 —— 只要生成器和校验器有一边改了格式，这里立刻报错。

tools/verify_pool.mjs 在 Node 侧做的是同一组判断，但用的是游戏引擎自己的
求解器。两边各写一遍是有意的：同一份不变量被两套独立实现交叉验证，
比只信一份实现更靠谱。
"""
from __future__ import annotations


class InconsistentPuzzle(ValueError):
    """题面与答案配不上。"""


# ------------------------------------------------------------------ 数织

def _runs(values: list[int]) -> list[int]:
    """一串 0/1 里连续 1 的段长。与引擎的 clueOfCells 同义。"""
    out: list[int] = []
    run = 0
    for v in values:
        if v:
            run += 1
        elif run:
            out.append(run)
            run = 0
    if run:
        out.append(run)
    return out


def _grid_of(rows: list[str]) -> list[list[int]]:
    return [[1 if ch == "#" else 0 for ch in row] for row in rows]


def _check_shuzhi(payload: dict, solution: dict) -> None:
    rows = solution.get("rows")
    if not isinstance(rows, list) or not rows:
        raise InconsistentPuzzle("数织答案缺少 rows")
    if not all(isinstance(r, str) and set(r) <= {"#", "."} for r in rows):
        raise InconsistentPuzzle("数织答案行只允许 # 和 .")

    h = len(rows)
    w = len(rows[0])
    if any(len(r) != w for r in rows):
        raise InconsistentPuzzle("数织答案各行长度不一致")
    if payload.get("h") != h or payload.get("w") != w:
        raise InconsistentPuzzle(
            f"题面标称 {payload.get('h')}×{payload.get('w')}，答案却是 {h}×{w}"
        )

    grid = _grid_of(rows)
    mode = payload.get("mode")

    if mode == "classic":
        row_clues = [_runs(row) for row in grid]
        col_clues = [_runs([grid[y][x] for y in range(h)]) for x in range(w)]
        if payload.get("rowClues") != row_clues:
            raise InconsistentPuzzle("经典模式：行线索与答案不符")
        if payload.get("colClues") != col_clues:
            raise InconsistentPuzzle("经典模式：列线索与答案不符")
        return

    if mode == "mosaik":
        clues = payload.get("clues")
        if not isinstance(clues, list) or len(clues) != h:
            raise InconsistentPuzzle("马赛克线索行数与答案不符")
        for y in range(h):
            if len(clues[y]) != w:
                raise InconsistentPuzzle("马赛克线索列数与答案不符")
            for x in range(w):
                y0, y1 = max(y - 1, 0), min(y + 1, h - 1)
                x0, x1 = max(x - 1, 0), min(x + 1, w - 1)
                total = sum(grid[yy][xx] for yy in range(y0, y1 + 1) for xx in range(x0, x1 + 1))
                if clues[y][x] != total:
                    raise InconsistentPuzzle(
                        f"马赛克模式：({y},{x}) 处线索写 {clues[y][x]}，答案算出来是 {total}"
                    )
        return

    raise InconsistentPuzzle(f"未知的数织模式: {mode!r}")


# ------------------------------------------------------------------ 数回

def _shuhui_edges(n: int) -> tuple[int, int]:
    """边编号约定：H(r,c) → r*n+c；V(r,c) → n*(n+1)+r*(n+1)+c。"""
    h_count = n * (n + 1)
    return h_count, 2 * n * (n + 1)


def _endpoints(e: int, n: int) -> tuple[int, int]:
    h_count, _ = _shuhui_edges(n)
    if e < h_count:
        r, c = divmod(e, n)
        return r * (n + 1) + c, r * (n + 1) + c + 1
    r, c = divmod(e - h_count, n + 1)
    return r * (n + 1) + c, (r + 1) * (n + 1) + c


def _cell_edges(r: int, c: int, n: int) -> tuple[int, int, int, int]:
    h_count, _ = _shuhui_edges(n)
    return (r * n + c, (r + 1) * n + c, h_count + r * (n + 1) + c, h_count + r * (n + 1) + c + 1)


def _check_shuhui(payload: dict, solution: dict) -> None:
    n = payload.get("n")
    if not isinstance(n, int) or n < 2:
        raise InconsistentPuzzle(f"数回盘面边长不合理: {n!r}")

    _, total_edges = _shuhui_edges(n)
    on = solution.get("on")
    if not isinstance(on, list) or not on:
        raise InconsistentPuzzle("数回答案未提供 on（回路边集合）")

    edges = set()
    for e in on:
        if not isinstance(e, int) or not (0 <= e < total_edges):
            raise InconsistentPuzzle(f"数回边编号越界: {e!r}")
        edges.add(e)

    # 1. 每个点上要么没有边，要么恰好两条 —— 排除分叉与线头
    degree: dict[int, int] = {}
    adjacency: dict[int, list[int]] = {}
    for e in edges:
        a, b = _endpoints(e, n)
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) + 1
        adjacency.setdefault(a, []).append(b)
        adjacency.setdefault(b, []).append(a)

    bad = {p: d for p, d in degree.items() if d != 2}
    if bad:
        example = next(iter(bad.items()))
        raise InconsistentPuzzle(
            f"数回答案在点 {example[0]} 处有 {example[1]} 条边（应为 2）—— 不是一条回路"
        )

    # 2. 全体 ON 边必须连通成"一个"环，而不是几个各自闭合的小环
    start = next(iter(degree))
    seen = {start}
    stack = [start]
    while stack:
        cur = stack.pop()
        for nxt in adjacency.get(cur, ()):
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    if len(seen) != len(degree):
        raise InconsistentPuzzle(
            f"数回答案不连通：{len(degree)} 个点里只有 {len(seen)} 个属于同一个环"
        )

    # 3. 每格的边数必须等于线索；没有线索的格子不设限
    clue = payload.get("clue")
    if not isinstance(clue, list) or len(clue) != n:
        raise InconsistentPuzzle("数回线索行数与盘面边长不符")
    for r in range(n):
        if len(clue[r]) != n:
            raise InconsistentPuzzle("数回线索列数与盘面边长不符")
        for c in range(n):
            expected = clue[r][c]
            if expected is None or expected < 0:
                continue
            actual = sum(1 for e in _cell_edges(r, c, n) if e in edges)
            if actual != expected:
                raise InconsistentPuzzle(
                    f"数回格 ({r},{c}) 线索是 {expected}，答案给出 {actual} 条边"
                )


# ------------------------------------------------------------------ 立方数独

def _check_shudu3d(payload: dict, solution: dict) -> None:
    """没有标准解，只检查题面参数自洽。

    这一款的判据是"六面各含 1~N² 一次"，不依赖某个具体局面，
    所以服务端不需要预先知道答案 —— 玩家走哪条路都行。
    """
    order = payload.get("order")
    if not isinstance(order, int) or not 2 <= order <= 6:
        raise InconsistentPuzzle(f"立方数独阶数不合理: {order!r}")

    seed = payload.get("seed")
    if not isinstance(seed, int) or not 0 <= seed <= 0xFFFFFFFF:
        raise InconsistentPuzzle(f"立方数独种子不合理: {seed!r}")

    scramble = payload.get("scramble")
    if not isinstance(scramble, int) or scramble < 1:
        raise InconsistentPuzzle(f"立方数独打乱步数不合理: {scramble!r}")

    if solution:
        raise InconsistentPuzzle("立方数独不应带标准解（判据是胜利条件本身）")


# ------------------------------------------------------------------ 入口

_CHECKS = {
    "shuzhi": _check_shuzhi,
    "shuhui": _check_shuhui,
    "shudu3d": _check_shudu3d,
}


def check_consistency(game: str, payload: dict, solution: dict) -> None:
    """配不上就抛 InconsistentPuzzle，配得上静默返回。"""
    check = _CHECKS.get(game)
    if check is None:
        return
    check(payload, solution)
