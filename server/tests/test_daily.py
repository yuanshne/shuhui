"""每日挑战：取题、交卷、计时、反作弊。"""
from __future__ import annotations

import pytest

from tests.conftest import API, GAME, VARIANTS, VARIANT, auth_header, register, submission_for

def fetch(client, game, day, **params):
    resp = client.get(f"{API}/daily/{GAME}", params={"date": day, **params})
    assert resp.status_code == 200, resp.text
    return resp.json()

def wrong_for(body):
    """按本游戏的交卷格式构造一个"答错"的提交。"""
    p = body["puzzle"]
    if GAME == "shuzhi":
        return {"rows": ["." * p["w"]] * p["h"]}
    if GAME == "shuhui":
        return {"on": []}
    order = p["order"]
    return {"faces": [list(order ** 2 * [1]) for _ in range(6)]}

def bad_format_for():
    """格式非法（不是答错）：字段类型不对，应当 400。"""
    if GAME == "shuzhi":
        return {"rows": "不是数组"}
    if GAME == "shuhui":
        return {"on": "不是数组"}
    return {"faces": "不是数组"}

def empty_for():
    """格式合法但内容为空的提交。"""
    if GAME == "shuzhi":
        return {"rows": []}
    if GAME == "shuhui":
        return {"on": []}
    return {"faces": []}

def any_key(obj, key: str) -> bool:
    if isinstance(obj, dict):
        return key in obj or any(any_key(v, key) for v in obj.values())
    if isinstance(obj, list):
        return any(any_key(v, key) for v in obj)
    return False


# ------------------------------------------------------------------ 取题

def test_daily_returns_puzzle_without_solution(client, day):
    body = fetch(client, GAME, day)
    assert body["game"] == GAME
    assert body["date"] == day
    assert body["puzzle"]
    # 答案绝不能出现在任何一层出参里
    assert not any_key(body, "solution")
    # 游客没有服务端计时
    assert body["timed"] is False
    assert body["started_at"] is None

def test_all_rankable_games_have_today_puzzle(client, day):
    assert fetch(client, GAME, day)["puzzle"]

def test_same_day_gives_same_puzzle_to_everyone(client, day):
    alice = register(client, "alice")["access_token"]
    bob = register(client, "bob")["access_token"]
    a = client.get(f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(alice)).json()
    b = client.get(f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(bob)).json()
    assert a["puzzle_id"] == b["puzzle_id"]
    assert a["puzzle"] == b["puzzle"]

@pytest.mark.skipif(len(VARIANTS) < 2, reason="本游戏只有一个玩法")
def test_different_variant_gives_different_puzzle(client, day):
    a = fetch(client, GAME, day, variant=VARIANTS[0])
    b = fetch(client, GAME, day, variant=VARIANTS[1])
    assert a["puzzle_id"] != b["puzzle_id"]

def test_unknown_game_is_404(client, day):
    assert client.get(f"{API}/daily/nope", params={"date": day}).status_code == 404

def test_bad_variant_is_422(client, day):
    resp = client.get(f"{API}/daily/{GAME}", params={"date": day, "variant": "nope"})
    assert resp.status_code == 422

def test_bad_date_format_is_422(client):
    resp = client.get(f"{API}/daily/{GAME}", params={"date": "2026-9-14"})
    assert resp.status_code == 422

def test_date_outside_pool_is_404(client):
    resp = client.get(f"{API}/daily/{GAME}", params={"date": "1999-01-01"})
    assert resp.status_code == 404


# ------------------------------------------------------------------ 交卷

def test_anonymous_can_submit_but_is_not_ranked(client, entries, day):
    entry = entries[(GAME, VARIANT)]
    body = fetch(client, GAME, day)
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": submission_for(entry)},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["correct"] is True
    assert data["ranked"] is False
    assert data["rank"] is None

def test_wrong_answer_is_200_with_correct_false(client, day):
    body = fetch(client, GAME, day)
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": wrong_for(body)},
    )
    assert resp.status_code == 200
    assert resp.json()["correct"] is False

def test_malformed_solution_is_400_not_200(client, day):
    """格式错误与答错要分开：前者是客户端 bug，不该悄悄记进统计里。"""
    body = fetch(client, GAME, day)
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": bad_format_for()},
    )
    assert resp.status_code == 400

def test_submit_unknown_puzzle_is_404(client):
    resp = client.post(
        f"{API}/daily/{GAME}/submit", json={"puzzle_id": 999999, "solution": empty_for()}
    )
    assert resp.status_code == 404

def test_logged_in_correct_submission_is_ranked(client, entries, day):
    token = register(client, "alice")["access_token"]
    body = client.get(
        f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
    ).json()
    assert body["timed"] is True and body["started_at"]

    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": submission_for(entries[(GAME, VARIANT)])},
        headers=auth_header(token),
    )
    data = resp.json()
    assert data["correct"] is True
    assert data["ranked"] is True
    assert data["rank"] == 1
    assert data["total"] == 1
    assert data["elapsed_ms"] >= 0
    assert data["improved"] is True

def test_guest_is_validated_but_not_ranked(client, entries, day):
    token = register(client, "guest_x", guest=True)["access_token"]
    body = client.get(
        f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
    ).json()
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": submission_for(entries[(GAME, VARIANT)])},
        headers=auth_header(token),
    )
    data = resp.json()
    assert data["correct"] is True
    assert data["ranked"] is False
    assert "注册" in data["message"]

def test_too_fast_submission_is_rejected(client_factory, entries, day):
    """服务端计时的意义：客户端报多快都没用，只认自己记的领题时刻。"""
    client = client_factory(min_elapsed_ms=60_000)
    token = register(client, "speedy")["access_token"]
    body = client.get(
        f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
    ).json()
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": submission_for(entries[(GAME, VARIANT)])},
        headers=auth_header(token),
    )
    data = resp.json()
    assert data["correct"] is True
    assert data["ranked"] is False
    assert "低于下限" in data["message"]

def test_expired_submission_is_rejected(client_factory, entries, day):
    client = client_factory(max_elapsed_ms=0)
    token = register(client, "slowpoke")["access_token"]
    body = client.get(
        f"{API}/daily/{GAME}", params={"date": day}, headers=auth_header(token)
    ).json()
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": submission_for(entries[(GAME, VARIANT)])},
        headers=auth_header(token),
    )
    assert resp.json()["ranked"] is False
    assert "超出计时窗口" in resp.json()["message"]

def test_submit_without_fetching_first_is_rejected_as_too_fast(client_factory, entries, day):
    """没领过题直接交卷 = 绕过了计时，必须挡下来。"""
    client = client_factory(min_elapsed_ms=1)
    token = register(client, "sneaky")["access_token"]
    # 先用游客身份拿到 puzzle_id，再换登录身份直接交卷
    pid = client.get(f"{API}/daily/{GAME}", params={"date": day}).json()["puzzle_id"]
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": pid, "solution": submission_for(entries[(GAME, VARIANT)])},
        headers=auth_header(token),
    )
    assert resp.json()["ranked"] is False

@pytest.mark.parametrize("variant", VARIANTS)
def test_every_pool_puzzle_is_accepted_by_its_own_validator(client, entries, day, variant):
    """端到端：题池里存的答案，交回去必须被判对。

    这条把"生成器写的格式"和"校验器读的格式"钉在一起 ——
    两边任何一边改了而另一边没跟上，这里立刻红。
    """
    token = register(client, f"u_{variant}")["access_token"]
    body = client.get(
        f"{API}/daily/{GAME}",
        params={"date": day, "variant": variant},
        headers=auth_header(token),
    ).json()
    resp = client.post(
        f"{API}/daily/{GAME}/submit",
        json={"puzzle_id": body["puzzle_id"], "solution": submission_for(entries[(GAME, variant)])},
        headers=auth_header(token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["correct"] is True


