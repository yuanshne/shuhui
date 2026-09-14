"""游戏注册表：本仓库内置后端只服务一款游戏。

后端不认识游戏的内部实现，只认「题面 JSON」与「答案 JSON」两件事：

    题面 (payload)   服务端 → 客户端，只含线索，不含答案
    答案 (solution)  只留在服务端，任何时候都不出现在接口出参里
    交卷 (submitted) 客户端 → 服务端，按 canonical 形式提交
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field


class ValidationError(ValueError):
    """交卷内容格式不对（不是"答错"，是"根本没法验"）。"""


def _validate_shuhui(payload: dict, solution: dict, submitted: dict) -> bool:
    """数回：唯一闭合回路。把 ON 边的编号集合拿来比对，与端序无关。

    边编号沿用引擎约定：H(r,c) → r*n+c，V(r,c) → n*(n+1)+r*(n+1)+c。
    客户端只报"哪些边在回路上"，顺序不限、允许重复。
    """
    on = submitted.get("on")
    if not isinstance(on, list):
        raise ValidationError("缺少 on 字段")

    edges = payload["n"] * (payload["n"] + 1) * 2
    try:
        got = {int(e) for e in on}
    except (TypeError, ValueError) as exc:
        raise ValidationError("on 里必须全是整数边编号") from exc

    if any(e < 0 or e >= edges for e in got):
        raise ValidationError(f"边编号超出范围 [0, {edges})")

    return got == set(solution["on"])


# --------------------------------------------------------------------------
# 注册表
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class GameSpec:
    id: str
    name: str
    kind: str  # 本仓库只服务判分类游戏
    variants: tuple[str, ...]
    difficulties: tuple[str, ...]
    validator: Callable[[dict, dict, dict], bool] | None = None
    daily_default: dict = field(default_factory=dict)
    accent: str = "#45d6c0"

    @property
    def rankable(self) -> bool:
        return self.kind == "puzzle"

    def check(self, payload: dict, solution: dict, submitted: dict) -> bool:
        """返回是否答对；交卷格式不合法则抛 ValidationError（→ 400）。"""
        return self.validator(payload, solution, submitted)


GAMES: dict[str, GameSpec] = {
    "shuhui": GameSpec(
        id="shuhui",
        name="数回",
        kind="puzzle",
        variants=("standard",),
        difficulties=("easy", "normal", "hard"),
        validator=_validate_shuhui,
        daily_default={"variant": "standard", "difficulty": "normal"},
        accent="#45d6c0",
    ),
}


def get_game(game_id: str) -> GameSpec:
    try:
        return GAMES[game_id]
    except KeyError:
        raise KeyError(f"未知游戏: {game_id}") from None
