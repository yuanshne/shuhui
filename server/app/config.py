"""集中配置。所有项都可以用 PUZZLE_ 前缀的环境变量覆盖。"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="PUZZLE_",
        extra="ignore",
    )

    app_name: str = "shuhui-server"
    version: str = "1.0.0"
    debug: bool = False

    # ---- 存储 ----
    database_url: str = "sqlite:///./data/puzzle.db"
    # 留空则自动探测 localhost:6379；探测不到就降级为进程内实现
    redis_url: str | None = None
    # auto：探测 Redis，失败降级；redis：必须成功，否则启动即报错；
    # memory：直接用进程内实现，连探测都不做（测试与单机演示用，省掉一次超时等待）
    storage_mode: str = "auto"
    pool_file: str = "data/pool.json"
    # 启动时是否把题池同步进库。测试用预灌好的库，会关掉它
    seed_on_startup: bool = True

    # ---- 鉴权 ----
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 天
    min_password_length: int = 6
    # bcrypt 代价因子。12 约 0.25s/次（防离线爆破）；测试里调低以免拖慢用例
    bcrypt_rounds: int = 12

    # ---- 每日挑战 ----
    # 按东八区切日：同一时刻全球玩家拿到同一道题
    daily_tz_offset_hours: int = 8
    # 服务端计时窗口：早于 / 晚于这个区间都判为异常提交
    min_elapsed_ms: int = 3000
    max_elapsed_ms: int = 6 * 60 * 60 * 1000

    # ---- 限流（固定窗口，Redis INCR 实现）----
    rate_limit_auth: int = 20          # 每 auth_window 秒内允许的鉴权请求数
    rate_limit_submit: int = 60        # 每 submit_window 秒内允许的交卷数
    rate_limit_read: int = 300         # 每 read_window 秒内允许的读取请求数
    auth_window: int = 60
    submit_window: int = 60
    read_window: int = 60

    # ---- WebSocket ----
    ws_channel: str = "puzzle:leaderboard"
    ws_ping_interval: int = 25


@lru_cache
def get_settings() -> Settings:
    return Settings()
