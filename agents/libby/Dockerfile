# Libby — DeepAgents-based agent, vendored source.
# Python 3.13, Debian-slim (musl + npx-spawned MCP stdio children don't mix).

FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        ripgrep \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY vendor/deepagents/ /opt/deepagents/
RUN test -f /opt/deepagents/libs/deepagents/pyproject.toml || (echo 'DeepAgents submodule missing; run git submodule update --init --recursive' && exit 1)

RUN pip install --no-cache-dir \
        /opt/deepagents/libs/deepagents \
        langchain-mcp-adapters \
        langchain-openai \
        httpx \
        langgraph-checkpoint-sqlite==3.1.0

COPY agents/libby/shim.py /app/shim.py

WORKDIR /app

ENTRYPOINT ["python", "/app/shim.py"]