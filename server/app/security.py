"""口令哈希与 JWT。

口令用 sha256 预摘要再过 bcrypt：
bcrypt 只取前 72 字节，中文口令一个字符 3 字节，直接喂进去会静默截断；
先做一次定长摘要就没有这个问题，且不影响 bcrypt 的慢哈希特性。
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt

from .config import get_settings


def _prehash(password: str) -> bytes:
    return hashlib.sha256(password.encode("utf-8")).digest()


def hash_password(password: str, rounds: int | None = None) -> str:
    """rounds 由调用方从 app.state.settings 传进来，好让测试调低代价。"""
    cost = rounds if rounds else get_settings().bcrypt_rounds
    return bcrypt.hashpw(_prehash(password), bcrypt.gensalt(rounds=cost)).decode("ascii")


def verify_password(password: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(_prehash(password), hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int, username: str, *, is_guest: bool = False) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "name": username,
        "guest": is_guest,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.jwt_expire_minutes)).timestamp()),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    """解析失败一律抛 jwt 的异常，由调用方翻成 401。"""
    s = get_settings()
    return jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
