"""依赖注入：当前用户、可选用户。"""
from __future__ import annotations

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .db import get_db
from .models import User
from .security import decode_access_token

bearer = HTTPBearer(auto_error=False, description="Bearer <JWT>")

_CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="登录状态无效或已过期",
    headers={"WWW-Authenticate": "Bearer"},
)


def _resolve(
    request: Request, creds: HTTPAuthorizationCredentials | None, db: Session
) -> User | None:
    if creds is None or not creds.credentials:
        return None
    try:
        payload = decode_access_token(creds.credentials)
    except jwt.PyJWTError:
        return None

    try:
        user_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        return None

    user = db.get(User, user_id)
    if user is None:
        return None

    # 共享给限流器，让它按用户而不是按 IP 计数
    request.state.user_id = user.id
    return user


def current_user_optional(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User | None:
    """带 token 且有效就返回用户，否则 None。用于"登录可选"的接口。"""
    return _resolve(request, creds, db)


def current_user(
    user: User | None = Depends(current_user_optional),
) -> User:
    if user is None:
        raise _CREDENTIALS_ERROR
    return user
