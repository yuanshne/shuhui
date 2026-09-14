# server/ —— 本游戏的联机后端

这款游戏的联机后端**内置在本仓库**（`server/`），不依赖任何外部服务。
FastAPI + SQLAlchemy + WebSocket：服务端出题、服务端判分、服务端计时 ——
客户端只发"我动了哪步"，分数由服务端从完整局面复算出来，改不了。
Redis 连不上时排行榜自动降级为进程内实现，单机部署零外部依赖（默认 SQLite）。

## 本地跑起来

```bash
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv\Scripts\pip
.venv/bin/python -m uvicorn app.main:app --port 8000
# 启动时自动把 data/pool.json 灌进数据库（90 天每日题，随仓库分发）
```

游戏端的联机地址解析顺序：`?api=` → localStorage → `<meta name="puzzle-api">` → 同源。

## 测试

```bash
cd server
.venv/bin/python -m pytest -q          # 服务端测试
node tools/test_client.mjs             # 客户端库端到端（对着真在跑的 uvicorn）
node tools/gen_pool.mjs                # 重新生成题池（写 data/pool.json）
```

关键防线：
- **答案只留在服务端**：接口出参里永远没有 solution 字段；
- **计时在服务端**：领题记 started_at，交卷算差值，客户端报的时间不采信；
- **格式错误（400）与答错（correct=false）是两回事**。
