"""健康检查 / 统计 / 限流。"""
from __future__ import annotations

from tests.conftest import API, GAME, VARIANT, auth_header, register, submission_for

# ------------------------------------------------------------------ health

def test_health_reports_all_backends(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"
    # 测试环境没有 Redis，两个后端都应处于降级状态
    assert body["leaderboard"] == "memory"
    assert body["realtime"] == "memory"
    assert body["live_connections"] == 0
    assert set(body["games"]) == {"shuhui"}


# ------------------------------------------------------------------ stats

def test_overview_covers_every_game(client):
    body = client.get(f"{API}/stats/overview").json()
    assert {g["game"] for g in body["games"]} == {
        "shuhui",
    }
    assert body["total_users"] == 0
    assert body["today"]


def test_stats_reflect_submissions(client, entries, day):
    token = register(client, "alice")["access_token"]
    puzzle = client.get(
        f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
    ).json()
    client.post(
        f"{API}/daily/{GAME}/submit",
        json={
            "puzzle_id": puzzle["puzzle_id"],
            "solution": submission_for(entries[(GAME, VARIANT)]),
        },
        headers=auth_header(token),
    )

    body = client.get(f"{API}/stats/{GAME}").json()
    assert body["plays"] == 1
    assert body["correct"] == 1
    assert body["solvers"] == 1
    assert body["best_ms"] is not None
    assert sum(body["distribution"].values()) == 1


def test_stats_for_unknown_game_is_404(client):
    assert client.get(f"{API}/stats/nope").status_code == 404


def test_total_users_excludes_guests(client):
    register(client, "real_user")
    register(client, "guest_user", guest=True)
    assert client.get(f"{API}/stats/overview").json()["total_users"] == 1


# ------------------------------------------------------------------ 事件

def test_read_limit_returns_429_with_retry_after(client_factory):
    client = client_factory(rate_limit_read=3)
    for _ in range(3):
        assert client.get(f"{API}/leaderboard/{GAME}").status_code == 200

    blocked = client.get(f"{API}/leaderboard/{GAME}")
    assert blocked.status_code == 429
    assert blocked.headers["Retry-After"] == "60"
    assert "过于频繁" in blocked.json()["detail"]


def test_auth_limit_is_separate_from_read_limit(client_factory):
    """两类接口各记各的账，刷榜被打回不该连累登录。"""
    client = client_factory(rate_limit_auth=2, rate_limit_read=100)
    register(client, "u1")
    register(client, "u2")
    assert client.post(f"{API}/auth/login", json={"username": "u1", "password": "pw123456"}).status_code == 429
    # 读接口不受影响
    assert client.get(f"{API}/leaderboard/{GAME}").status_code == 200
