"""测试夹具。

题池直接用仓库里提交的那份 data/pool.json：
它是真实生成器的产物，测试用它就等于顺手做了端到端一致性检查；
再另造一份假题池反而测不出格式漂移。

各测试都用 pool 的起始日期，不依赖"今天是几号"，跑在任何一天结果都一样。
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.config import Settings
from app.db import build_engine, init_db, make_session_factory
from app.main import create_app
from app.seed import load_pool

# 本 server 只服务这一款游戏（后端内置在游戏仓库里，随仓库分发）
GAME = "shuhui"
VARIANT = "standard"
VARIANTS = ['standard']

ROOT = Path(__file__).resolve().parent.parent
POOL_PATH = ROOT / "data" / "pool.json"


@pytest.fixture(scope="session")
def pool() -> dict:
    return json.loads(POOL_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def day(pool: dict) -> str:
    """题池覆盖的第一天。"""
    return pool["start"]


@pytest.fixture(scope="session")
def entries(pool: dict, day: str) -> dict[tuple[str, str], dict]:
    return {(e["game"], e["variant"]): e for e in pool["entries"] if e["date"] == day}


def submission_for(entry: dict) -> dict:
    """把题池里的标准答案转成客户端交卷的格式。"""
    game = entry["game"]
    solution = entry["solution"]
    if game == "shuzhi":
        return {"rows": solution["rows"]}
    if game == "shuhui":
        return {"on": solution["on"]}
    if game == "shudu3d":
        # 立方数独没有标准答案：服务端只验胜利条件（每面恰好 1~N² 各一次），
        # 这里按题面的 order 构造一个必然获胜的局面。
        order = entry["payload"]["order"]
        return {"faces": [list(range(1, order ** 2 + 1)) for _ in range(6)]}
    raise ValueError(f"{game} 没有可以直接交卷的标准答案")


@pytest.fixture(scope="session")
def seeded_db(tmp_path_factory) -> Path:
    """整个测试会话只灌一次题池，得到一份"装好题的干净库"。

    每个用例再把它复制一份出来用。题池有 360 道题、每道都要过一遍自洽性校验，
    为每个用例都灌一次会让整个套件从十几秒变成一分多钟 —— 而复制一个 SQLite
    文件只要几毫秒。
    """
    path = tmp_path_factory.mktemp("seed") / "template.db"
    engine = build_engine(f"sqlite:///{path.as_posix()}")
    init_db(engine)
    with make_session_factory(engine)() as db:
        load_pool(db, POOL_PATH)
        # 把 WAL 里的内容并回主文件，否则复制出去的库会缺数据
        db.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
        db.commit()
    engine.dispose()
    return path


@pytest.fixture()
def client_factory(tmp_path, seeded_db):
    """按需构造带独立数据库的 TestClient。

    每次调用都会起一个全新的 app（自己的库、自己的内存排行榜），
    这样测试之间不会互相污染；退出时统一关掉 lifespan。
    """
    opened: list[TestClient] = []

    def make(**overrides) -> TestClient:
        index = len(opened)
        db_path = tmp_path / f"t{index}.db"
        shutil.copyfile(seeded_db, db_path)

        defaults = {
            "database_url": f"sqlite:///{db_path.as_posix()}",
            "redis_url": None,
            "storage_mode": "memory",  # 不去探测 Redis，省掉每个用例一次连接超时
            "pool_file": str(POOL_PATH),
            "seed_on_startup": False,  # 题池已由 seeded_db 灌好
            "jwt_secret": "test-secret-that-is-long-enough-for-hs256",
            # 测试里把 bcrypt 代价调到最低，12 轮会让每个用例多花几百毫秒
            "bcrypt_rounds": 4,
            # 默认关掉时间门禁，免得每个测试都要等 3 秒
            "min_elapsed_ms": 0,
            "max_elapsed_ms": 10**9,
            "rate_limit_auth": 10_000,
            "rate_limit_submit": 10_000,
            "rate_limit_read": 10_000,
        }
        defaults.update(overrides)
        app = create_app(Settings(**defaults))
        client = TestClient(app)
        client.__enter__()  # 触发 lifespan：建表、灌题池
        opened.append(client)
        return client

    yield make

    for client in opened:
        client.__exit__(None, None, None)


@pytest.fixture()
def client(client_factory) -> TestClient:
    return client_factory()


# ---------------------------------------------------------------- 小工具

def register(client: TestClient, username: str, password: str = "pw123456", **kw) -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": password, **kw},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


API = "/api/v1"
