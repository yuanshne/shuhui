FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 依赖单独一层，代码改动不会让依赖重装
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web
COPY data ./data

# 库文件写到挂载卷里，镜像本身保持无状态
ENV PUZZLE_DATABASE_URL=sqlite:///./var/puzzle.db
RUN mkdir -p var && useradd --create-home --shell /usr/sbin/nologin appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; \
sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status==200 else sys.exit(1)"

# 单进程起步。要横向扩就加 --workers，状态都在 Redis 里，多进程安全
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
