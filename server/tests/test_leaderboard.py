"""排行榜：后端实现（内存 + Redis）与 HTTP 读路径。"""
from __future__ import annotations

import fakeredis
import pytest

from app.leaderboard import MemoryBackend, RedisBackend, board_key
from app.services import format_elapsed
from tests.conftest import API, GAME, VARIANT, auth_header, register, submission_for

# ------------------------------------------------------------------ 后端实现

@pytest.fixture(params=["memory", "redis"])
def backend(request):
    """两套实现跑同一组断言 —— 降级路径不能是"没测过的那条路"。"""
    if request.param == "memory":
        return MemoryBackend()
    return RedisBackend(fakeredis.FakeRedis())


def test_record_and_rank(backend):
    key = "lb:test"
    backend.record(key, "alice", 30_000)
    backend.record(key, "bob", 10_000)
    backend.record(key, "carol", 20_000)

    assert backend.rank(key, "bob") == 0
    assert backend.rank(key, "carol") == 1
    assert backend.rank(key, "alice") == 2
    assert backend.rank(key, "nobody") is None
    assert backend.size(key) == 3
    assert backend.top(key, 2) == [("bob", 10_000.0), ("carol", 20_000.0)]


def test_only_personal_best_is_kept(backend):
    key = "lb:test"
    backend.record(key, "alice", 50_000)
    backend.record(key, "alice", 80_000)  # 更慢，不该覆盖
    assert backend.top(key, 5) == [("alice", 50_000.0)]

    backend.record(key, "alice", 20_000)  # 更快，应当覆盖
    assert backend.top(key, 5) == [("alice", 20_000.0)]
    assert backend.size(key) == 1


def test_boards_are_isolated(backend):
    backend.record(board_key(GAME, VARIANT, "2026-09-14"), "alice", 1_000)
    backend.record(board_key(GAME, VARIANT, None), "bob", 2_000)
    backend.record(board_key(GAME, VARIANT, "2026-09-15"), "carol", 3_000)

    assert backend.size(board_key(GAME, VARIANT, "2026-09-14")) == 1
    assert backend.size(board_key(GAME, VARIANT, None)) == 1
    assert backend.size(board_key(GAME, VARIANT, "2026-09-15")) == 1
    assert backend.size(board_key(GAME, VARIANT, "2026-09-16")) == 0


def test_clear(backend):
    key = "lb:test"
    backend.record(key, "alice", 1)
    backend.clear(key)
    assert backend.size(key) == 0


# ------------------------------------------------------------------ 格式化

@pytest.mark.parametrize(
    "ms, expect",
    [
        (0, "0.0s"),
        (1_500, "1.5s"),
        (59_900, "59.9s"),
        (60_000, "1:00.0"),
        (125_400, "2:05.4"),
        (3_600_000, "60:00.0"),
    ],
)
def test_format_elapsed(ms, expect):
    assert format_elapsed(ms) == expect


# ------------------------------------------------------------------ HTTP

def test_empty_board(client, day):
    body = client.get(f"{API}/leaderboard/{GAME}", params={"date": day}).json()
    assert body["entries"] == []
    assert body["total"] == 0
    assert body["scope"] == "daily"
    assert body["backend"] in {"memory", "redis"}


def test_board_orders_by_elapsed_and_marks_ties(client, day):
    board = client.app.state.leaderboard
    key = board_key(GAME, VARIANT, day)
    board.record(key, "alice", 30_000)
    board.record(key, "bob", 10_000)
    board.record(key, "carol", 10_000)
    board.record(key, "dave", 20_000)

    body = client.get(f"{API}/leaderboard/{GAME}", params={"date": day}).json()
    names = [e["username"] for e in body["entries"]]
    assert names == ["bob", "carol", "dave", "alice"]
    ranks = [e["rank"] for e in body["entries"]]
    # 并列同分同名次，后续名次按实际位置走
    assert ranks == [1, 1, 3, 4]
    assert body["entries"][0]["elapsed_text"] == "10.0s"


def test_limit_is_honoured(client, day):
    board = client.app.state.leaderboard
    for i in range(10):
        board.record(board_key(GAME, VARIANT, day), f"u{i}", i * 1000)
    body = client.get(
        f"{API}/leaderboard/{GAME}", params={"date": day, "limit": 3}
    ).json()
    assert len(body["entries"]) == 3
    assert body["total"] == 10  # total 是全量，不受 limit 影响


def test_limit_out_of_range_is_422(client, day):
    assert client.get(f"{API}/leaderboard/{GAME}", params={"limit": 0}).status_code == 422
    assert client.get(f"{API}/leaderboard/{GAME}", params={"limit": 500}).status_code == 422


def test_bad_scope_is_422(client, day):
    assert client.get(f"{API}/leaderboard/{GAME}", params={"scope": "weekly"}).status_code == 422


def test_all_time_scope_ignores_date(client, day):
    board = client.app.state.leaderboard
    board.record(board_key(GAME, VARIANT, day), "alice", 5_000)
    board.record(board_key(GAME, VARIANT, None), "bob", 1_000)

    daily = client.get(f"{API}/leaderboard/{GAME}", params={"date": day}).json()
    alltime = client.get(f"{API}/leaderboard/{GAME}", params={"scope": "all"}).json()
    assert [e["username"] for e in daily["entries"]] == ["alice"]
    assert [e["username"] for e in alltime["entries"]] == ["bob"]
    assert alltime["date"] is None


def test_unknown_game_is_404(client):
    assert client.get(f"{API}/leaderboard/nope").status_code == 404


def test_rank_endpoint_requires_login(client, day):
    assert client.get(f"{API}/leaderboard/{GAME}/rank", params={"date": day}).status_code == 401


def test_rank_endpoint_reports_position(client, day):
    token = register(client, "alice")["access_token"]
    board = client.app.state.leaderboard
    key = board_key(GAME, VARIANT, day)
    board.record(key, "bob", 10_000)
    board.record(key, "alice", 20_000)

    body = client.get(
        f"{API}/leaderboard/{GAME}/rank", params={"date": day}, headers=auth_header(token)
    ).json()
    assert body == {"on_board": True, "rank": 2, "total": 2, "elapsed_ms": 20_000}


def test_rank_endpoint_when_not_on_board(client, day):
    token = register(client, "newbie")["access_token"]
    body = client.get(
        f"{API}/leaderboard/{GAME}/rank", params={"date": day}, headers=auth_header(token)
    ).json()
    assert body["on_board"] is False
    assert body["rank"] is None


def test_real_submission_lands_on_both_boards(client, entries, day):
    """端到端：交一份正确的卷，当日榜与历史总榜都该有这个人。"""
    token = register(client, "alice")["access_token"]
    puzzle = client.get(
        f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
    ).json()
    from tests.conftest import submission_for

    client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": puzzle["puzzle_id"], "solution": submission_for(entries[(GAME, VARIANT)])},
        headers=auth_header(token),
    )

    daily = client.get(f"{API}/leaderboard/{GAME}", params={"date": day}).json()
    alltime = client.get(f"{API}/leaderboard/{GAME}", params={"scope": "all"}).json()
    assert [e["username"] for e in daily["entries"]] == ["alice"]
    assert [e["username"] for e in alltime["entries"]] == ["alice"]


def test_wrong_submission_does_not_land_on_board(client, entries, day):
    token = register(client, "alice")["access_token"]
    puzzle = client.get(
        f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
    ).json()
    p = puzzle["puzzle"]
    if GAME == "shuzhi":
        sol = {"rows": ["." * p["w"]] * p["h"]}
    elif GAME == "shuhui":
        sol = {"on": []}
    else:
        order = p["order"]
        sol = {"faces": [list(order ** 2 * [1]) for _ in range(6)]}
    client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": puzzle["puzzle_id"], "solution": sol},
        headers=auth_header(token),
    )
    assert client.get(f"{API}/leaderboard/{GAME}", params={"date": day}).json()["total"] == 0
