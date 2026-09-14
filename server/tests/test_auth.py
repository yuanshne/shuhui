"""账号相关。"""
from __future__ import annotations

from tests.conftest import API, auth_header, register


def test_register_returns_token_and_user(client):
    body = register(client, "alice")
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["expires_in"] > 0
    assert body["user"]["username"] == "alice"
    assert body["user"]["is_guest"] is False
    assert "password" not in str(body)


def test_register_duplicate_username_conflicts(client):
    register(client, "bob")
    resp = client.post(API + "/auth/register", json={"username": "bob", "password": "pw123456"})
    assert resp.status_code == 409


def test_register_rejects_short_password(client):
    resp = client.post(API + "/auth/register", json={"username": "carol", "password": "abc"})
    assert resp.status_code == 422


def test_register_rejects_illegal_username(client):
    for bad in ["  ", "a b", "a" * 21, "bad!name"]:
        resp = client.post(
            API + "/auth/register", json={"username": bad, "password": "pw123456"}
        )
        assert resp.status_code == 422, f"{bad!r} 本应被拒"


def test_chinese_username_and_password_roundtrip(client):
    """中文口令走 sha256 预摘要分支 —— bcrypt 只取前 72 字节，长中文口令会被静默截断。"""
    long_password = "很长的中文口令" * 12  # 远超 72 字节
    register(client, "小明", long_password)

    ok = client.post(API + "/auth/login", json={"username": "小明", "password": long_password})
    assert ok.status_code == 200

    bad = client.post(API + "/auth/login", json={"username": "小明", "password": long_password + "x"})
    assert bad.status_code == 401


def test_login_wrong_password_is_401(client):
    register(client, "dave")
    resp = client.post(API + "/auth/login", json={"username": "dave", "password": "wrong-pw"})
    assert resp.status_code == 401


def test_login_unknown_user_is_401_with_same_message(client):
    """不存在的用户名与错误口令返回同一个提示，避免用户名枚举。"""
    register(client, "erin")
    unknown = client.post(API + "/auth/login", json={"username": "nobody", "password": "x"})
    wrong = client.post(API + "/auth/login", json={"username": "erin", "password": "x"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]


def test_me_requires_valid_token(client):
    token = register(client, "frank")["access_token"]
    assert client.get(API + "/auth/me", headers=auth_header(token)).status_code == 200

    assert client.get(API + "/auth/me").status_code == 401
    assert client.get(API + "/auth/me", headers=auth_header("not-a-jwt")).status_code == 401


def test_token_signed_with_other_secret_is_rejected(client_factory):
    """换一把密钥签出来的 token 必须无效 —— 否则 JWT 形同虚设。"""

    a = client_factory(jwt_secret="secret-a")
    token = register(a, "grace")["access_token"]

    b = client_factory(jwt_secret="secret-b")
    assert b.get(API + "/auth/me", headers=auth_header(token)).status_code == 401


def test_guest_flag_is_recorded(client):
    body = register(client, "guest_001", guest=True)
    assert body["user"]["is_guest"] is True
