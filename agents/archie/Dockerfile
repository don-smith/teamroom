# Archie — DeepAgents-based agent, vendored source.
# Python 3.13 (latest stable supported by DeepAgents per plan Decision 2).
# Debian-slim not Alpine (musl + npx-spawned MCP stdio children don't mix).

FROM python:3.13-slim

# Build dependencies for wheels that may need a C toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        ripgrep \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Vendored DeepAgents source, copied into the image.
# Layout inside /opt matches vendor/deepagents/ at the commit pinned by the
# repo's submodule pointer.
COPY vendor/deepagents/ /opt/deepagents/
RUN test -f /opt/deepagents/libs/deepagents/pyproject.toml || (echo 'DeepAgents submodule missing; initialize it with: git submodule update --init --recursive' && exit 1)

# Install DeepAgents from the vendored source, plus MCP adapter + Anthropic
# LangChain integration + LangGraph SQLite checkpointer.
# (DeepAgents' own deps are resolved from its pyproject.toml; this pulls them
# transitively.)
#
# Checkpointer upgrade note: Archie persists LangGraph checkpoints at
# /store/langgraph-checkpoint.db. The database schema is owned by the pinned
# DeepAgents/LangGraph versions. Before upgrading langgraph-checkpoint-sqlite
# or the vendored DeepAgents submodule, back up /store and verify checkpoint
# compatibility; there is no automatic migration path.
RUN pip install --no-cache-dir \
        /opt/deepagents/libs/deepagents \
        langchain-mcp-adapters \
        langchain-anthropic \
        langchain-openai \
        httpx \
        langgraph-checkpoint-sqlite==3.1.0 \
        pytest==9.0.3 \
        pytest-asyncio==1.4.0

# Our shim is the container's entrypoint.
COPY agents/archie/shim.py /app/shim.py

# /store is a mounted volume; writable by the shim for the checkpointer DB.
# /codebase is also mounted; read-write to the team's working tree.
WORKDIR /app

ENTRYPOINT ["python", "/app/shim.py"]
