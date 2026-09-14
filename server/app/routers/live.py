"""实时榜单 WebSocket。

客户端连上就先收一份当前快照，之后每次有人上榜都会收到新的完整快照 ——
不推增量。排行榜条目本身就是几十条，推全量比维护增量 diff 简单得多，
也不会出现"客户端状态和服务器不一致"的问题。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..clock import today_str
from ..games import get_game
from ..services import leaderboard_payload

log = logging.getLogger(__name__)

router = APIRouter(tags=["实时"])

# 自定义关闭码：4004 未知游戏，4003 玩法不对
WS_UNKNOWN_GAME = 4004
WS_BAD_VARIANT = 4003


@router.websocket("/ws/leaderboard/{game}")
async def ws_leaderboard(websocket: WebSocket, game: str, variant: str | None = None) -> None:
    try:
        spec = get_game(game)
    except KeyError:
        await websocket.close(code=WS_UNKNOWN_GAME, reason=f"未知游戏: {game}")
        return

    chosen = variant or spec.daily_default["variant"]
    if chosen not in spec.variants:
        await websocket.close(code=WS_BAD_VARIANT, reason=f"未知玩法: {chosen}")
        return

    hub = websocket.app.state.hub
    backend = websocket.app.state.leaderboard
    topic = f"leaderboard:{spec.id}:{chosen}"

    await hub.connect(topic, websocket)
    try:
        # 先给一份快照，客户端不用再单独拉一次 REST
        await websocket.send_json(
            leaderboard_payload(spec, chosen, "daily", today_str(), backend)
        )
        while True:
            # 只用来探测断线；客户端发什么内容都不影响服务端状态
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001 - 单条连接出错不该影响别人
        log.debug("WebSocket 异常关闭 (%s): %s", topic, exc)
    finally:
        await hub.disconnect(topic, websocket)
