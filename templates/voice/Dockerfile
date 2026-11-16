FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install --no-install-recommends -y libgomp1 && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 1000 agent
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY --chown=agent:agent . .
USER agent
CMD [".venv/bin/python", "main.py", "start"]
