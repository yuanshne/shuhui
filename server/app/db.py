"""数据库连接。

引擎与会话工厂挂在 app.state 上，由 lifespan 按配置创建 —— 不做模块级全局单例。
理由是测试与多实例部署都需要"同一份代码、不同的库"，全局单例会让这两件事
只能靠 monkeypatch 硬凑。
"""
from __future__ import annotations

import os
from collections.abc import Iterator

from fastapi import Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def _ensure_sqlite_dir(url: str) -> None:
    """SQLite 文件所在目录不存在时先建出来，否则 create_engine 会报错。"""
    if not url.startswith("sqlite:///"):
        return
    path = url[len("sqlite:///") :]
    if path in ("", ":memory:"):
        return
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def build_engine(url: str, *, echo: bool = False) -> Engine:
    _ensure_sqlite_dir(url)
    connect_args = {}
    if url.startswith("sqlite"):
        # TestClient 与线程池里的请求会跨线程用同一个连接
        connect_args["check_same_thread"] = False
    engine = create_engine(url, echo=echo, future=True, connect_args=connect_args)

    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _rec):  # pragma: no cover - 依赖具体驱动
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db(engine: Engine) -> None:
    """建表。幂等。"""
    from . import models  # noqa: F401  确保模型已注册到 metadata

    Base.metadata.create_all(bind=engine)


def get_db(request: Request) -> Iterator[Session]:
    factory: sessionmaker[Session] = request.app.state.session_factory
    db = factory()
    try:
        yield db
    finally:
        db.close()
