"""实时推送。"""
from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from tests.conftest import API, GAME, VARIANT, auth_header, register, submission_for


def test_snapshot_is_sent_on_connect(client):
    with client.websocket_connect(f"/ws/leaderboard/{GAME}?variant={VARIANT}") as ws:
        snapshot = ws.receive_json()
        assert snapshot["type"] == "leaderboard"
        assert snapshot["game"] == GAME
        assert snapshot["variant"] == VARIANT
        assert snapshot["scope"] == "daily"
        assert snapshot["entries"] == []
        assert snapshot["total"] == 0


def test_update_is_pushed_after_a_ranked_submission(client, entries, day):
    token = register(client, "alice")["access_token"]

    with client.websocket_connect(f"/ws/leaderboard/{GAME}?variant={VARIANT}") as ws:
        assert ws.receive_json()["entries"] == []

        puzzle = client.get(
            f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
        ).json()
        resp = client.post(
            f"{API}/daily/{GAME}/submit",
            json={
                "puzzle_id": puzzle["puzzle_id"],
                "solution": submission_for(entries[(GAME, VARIANT)]),
            },
            headers=auth_header(token),
        )
        assert resp.json()["ranked"] is True

        pushed = ws.receive_json()
        assert pushed["type"] == "leaderboard"
        assert [e["username"] for e in pushed["entries"]] == ["alice"]
        assert pushed["total"] == 1


def test_no_push_when_submission_is_not_ranked(client, entries, day):
    """游客不上榜，也就不该触发推送。

    判定方式：交卷后用 get_leaderboard 的 REST 读一次当日榜 ——
    推送的载荷就是同一个快照，榜是空的说明没有可推的内容。
    """
    token = register(client, "guest_a", guest=True)["access_token"]

    with client.websocket_connect(f"/ws/leaderboard/{GAME}?variant={VARIANT}") as ws:
        assert ws.receive_json()["entries"] == []

        puzzle = client.get(
            f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
        ).json()
        resp = client.post(
            f"{API}/daily/{GAME}/submit",
            json={
                "puzzle_id": puzzle["puzzle_id"],
                "solution": submission_for(entries[(GAME, VARIANT)]),
            },
            headers=auth_header(token),
        )
        assert resp.json()["correct"] is True
        assert resp.json()["ranked"] is False

        board = client.get(f"{API}/leaderboard/{GAME}", params={"date": day}).json()
        assert board["entries"] == []
        assert board["total"] == 0


def test_unknown_game_closes_with_4004(client):
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        client.websocket_connect("/ws/leaderboard/nope") as ws,
    ):
        ws.receive_json()
    assert exc.value.code == 4004


def test_bad_variant_closes_with_4003(client):
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        client.websocket_connect(f"/ws/leaderboard/{GAME}?variant=nope") as ws,
    ):
        ws.receive_json()
    assert exc.value.code == 4003


def test_disconnect_frees_the_slot(client):
    assert client.app.state.hub.connection_count() == 0
    with client.websocket_connect(f"/ws/leaderboard/{GAME}") as ws:
        ws.receive_json()
        assert client.app.state.hub.connection_count() == 1
    assert client.app.state.hub.connection_count() == 0
