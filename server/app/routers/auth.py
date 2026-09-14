"""账号：注册 / 登录 / 查自己。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..models import User
from ..ratelimit import rate_limit
from ..schemas import LoginIn, RegisterIn, TokenOut, UserOut
from ..security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["鉴权"])


def _issue(user: User, request: Request) -> TokenOut:
    settings = request.app.state.settings
    return TokenOut(
        access_token=create_access_token(user.id, user.username, is_guest=user.is_guest),
        expires_in=settings.jwt_expire_minutes * 60,
        user=UserOut.model_validate(user),
    )


@router.post(
    "/register",
    response_model=TokenOut,
    status_code=status.HTTP_201_CREATED,
    summary="注册并直接返回令牌",
    dependencies=[
        Depends(rate_limit("auth", "rate_limit_auth", "auth_window"))
    ],
)
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)) -> TokenOut:
    exists = db.scalar(select(User).where(User.username == body.username))
    if exists is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="用户名已被占用")

    user = User(
        username=body.username,
        password_hash=hash_password(
            body.password, request.app.state.settings.bcrypt_rounds
        ),
        is_guest=body.guest,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _issue(user, request)


@router.post(
    "/login",
    response_model=TokenOut,
    summary="登录",
    dependencies=[
        Depends(rate_limit("auth", "rate_limit_auth", "auth_window"))
    ],
)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)) -> TokenOut:
    user = db.scalar(select(User).where(User.username == body.username))
    # 用户名不存在与口令错误返回同一个提示，避免用户名枚举
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")
    return _issue(user, request)


@router.get("/me", response_model=UserOut, summary="当前登录用户")
def me(user: User = Depends(current_user)) -> UserOut:
    return UserOut.model_validate(user)
