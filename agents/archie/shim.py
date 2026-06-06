#!/usr/bin/env python3
"""
Archie container entrypoint.

Reads {"type":"wake","events":[...]} JSON envelopes from stdin, one per line.
On each wake, invokes the DeepAgents graph with a canned "check your inbox"
prompt; the graph itself (mail-MCP tools + DeepAgents filesystem tools) does
the real work. Errors are printed to stderr; the wake loop continues.

Environment (injected by Team Room's build-spec.ts):
  TEAMROOM_AGENT_NAME     — "archie"
  TEAMROOM_MCP_URL        — http://host.docker.internal:<port>/mcp
  TEAMROOM_MCP_TOKEN      — bearer for mail-MCP
  TEAMROOM_MODEL_BASE_URL — daemon proxy URL (OpenAI-compat)
  ANTHROPIC_BASE_URL      — daemon proxy URL (Anthropic-shape)
  ANTHROPIC_AUTH_TOKEN    — proxy-minted token
  TEAMROOM_MODEL          — e.g. "claude-opus-4-7"

API notes (verified against vendor/deepagents/libs/deepagents/deepagents/graph.py):
  - create_deep_agent accepts system_prompt= (not instructions=)
  - checkpointer= is a direct kwarg on create_deep_agent (graph.py line 230)
  - create_deep_agent returns a CompiledStateGraph; use .ainvoke()
  - AsyncSqliteSaver.from_conn_string is an async context manager
    (confirmed from vendor/deepagents/libs/cli/deepagents_cli/sessions.py);
    opened once in main() and held for the process lifetime.
  - MCP get_tools() makes a network call; deferred to first wake so the
    boot path (building agent, printing "ready") does not depend on MCP
    reachability. Agent is rebuilt on first wake only.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from deepagents import create_deep_agent
from deepagents.backends.filesystem import FilesystemBackend
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver


WAKE_PROMPT = (
    "A new-mail wake fired. Check your inbox with mail_list (unreadOnly=false). "
    "For each message, use mail_get to read the full thread, do whatever "
    "reading/editing under /codebase the message asks for, and reply with "
    "mail_reply. If the inbox is empty, do nothing and report 'no mail'."
)


def load_system_prompt() -> str:
    path = Path("/AGENTS.md")
    if path.exists():
        return path.read_text()
    return "You are Archie, Team Room's architect."


def make_model() -> ChatOpenAI:
    """Build the LLM instance using OpenRouter (OpenAI-compatible endpoint).

    Uses OPENROUTER_API_KEY and OPENROUTER_MODEL from environment (injected by
    build-spec.ts when present in .env). Falls back to the daemon proxy path
    for the default configuration.
    """
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    openrouter_model = os.environ.get("OPENROUTER_MODEL")

    if openrouter_key and openrouter_model:
        return ChatOpenAI(
            model=openrouter_model,
            base_url="https://openrouter.ai/api/v1",
            api_key=openrouter_key,
            http_client=httpx.Client(
                headers={
                    "HTTP-Referrer": "https://teamroom.local",
                    "X-Title": "Team Room Archie",
                },
            ),
        )

    # Fallback: route through the daemon's Anthropic-shape proxy.
    # This must use ChatAnthropic, not ChatOpenAI: Team Room's Anthropic
    # adapter forwards Anthropic `/v1/messages` requests, not OpenAI
    # `/chat/completions` requests.
    anthropic_base = os.environ["ANTHROPIC_BASE_URL"]
    anthropic_token = os.environ["ANTHROPIC_AUTH_TOKEN"]
    model_id = os.environ.get("TEAMROOM_MODEL", "claude-opus-4-7")
    return ChatAnthropic(
        model_name=model_id,
        base_url=anthropic_base,
        api_key=anthropic_token,
    )


async def build_agent(checkpointer: AsyncSqliteSaver):
    """Fetch MCP tools (network call) and compile the DeepAgents graph.

    Called on the first wake, not at boot, so that the boot path does not
    depend on MCP reachability.
    """
    mcp_url = os.environ["TEAMROOM_MCP_URL"]
    mcp_token = os.environ["TEAMROOM_MCP_TOKEN"]

    mcp_client = MultiServerMCPClient(
        {
            "mail": {
                "transport": "streamable_http",
                "url": mcp_url,
                "headers": {"x-teamroom-mcp-token": mcp_token},
            },
        }
    )
    try:
        raw_tools = await mcp_client.get_tools()
    except Exception as err:
        # Re-raise with the MCP URL in the message so operators can see what
        # was unreachable. The original exception is chained via `from`.
        raise RuntimeError(
            f"failed to connect to mail-MCP at {mcp_url}: {err!r}"
        ) from err

    def _rename_tool_dots_to_underscores(tool):
        """Anthropic's API requires tool names match `^[a-zA-Z0-9_-]{1,128}$`.
        Mail-MCP exposes tools with dots (mail.list etc.). Rename in-flight so
        DeepAgents passes Anthropic-compatible names through ChatAnthropic.
        Idempotent — safe to call on already-underscored names."""
        new_name = tool.name.replace(".", "_")
        if new_name == tool.name:
            return tool
        # Try the cheap path: direct attribute set. Most LangChain BaseTool
        # subclasses allow this. If it raises (frozen Pydantic), fall back
        # to model_copy with update.
        try:
            tool.name = new_name
            return tool
        except (AttributeError, TypeError, ValueError):
            # Pydantic v2 frozen fallback. model_copy preserves the rest.
            return tool.model_copy(update={"name": new_name})

    mail_tools = [_rename_tool_dots_to_underscores(t) for t in raw_tools]

    model = make_model()

    # FilesystemBackend gives the agent real filesystem access to /codebase
    # (the team's shared working tree) and /store (our persistent scratch).
    # Without this, DeepAgents uses StateBackend which stores files in ephemeral
    # agent state, not on the actual filesystem.
    # virtual_mode=False uses the actual filesystem (not virtual path semantics).
    fs_backend = FilesystemBackend(root_dir="/codebase", virtual_mode=False)

    # checkpointer= is a direct kwarg on create_deep_agent (confirmed from
    # vendor/deepagents/libs/deepagents/deepagents/graph.py line 230).
    # system_prompt= is correct; instructions= does not exist in this version.
    agent = create_deep_agent(
        model=model,
        tools=mail_tools,
        system_prompt=load_system_prompt(),
        checkpointer=checkpointer,
        backend=fs_backend,
    )
    return agent


async def handle_wake(
    state: dict, checkpointer: AsyncSqliteSaver, envelope: dict
) -> None:
    # envelope is intentionally unused for M6 — the canned WAKE_PROMPT covers
    # "check your inbox and act on whatever's there"; a later milestone may
    # surface event hints (e.g., mail-thread id) into the prompt.
    # Build agent on first wake; cache in state dict for subsequent wakes.
    if state.get("agent") is None:
        print(
            "[archie] first wake: connecting to MCP and building agent", file=sys.stderr
        )
        state["agent"] = await build_agent(checkpointer)
        print("[archie] first wake: agent ready", file=sys.stderr)

    agent = state["agent"]

    # Single thread id for all M6 wakes — lets the checkpointer accumulate
    # history across wakes. A later milestone can key on mail thread_id.
    thread_id = "archie-main"
    config = {"configurable": {"thread_id": thread_id}}
    print(f"[archie] invoking agent with prompt: {WAKE_PROMPT}", file=sys.stderr)
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": WAKE_PROMPT}]},
        config=config,
    )
    # Log full result for debugging
    print(f"[archie] result keys: {result.keys()}", file=sys.stderr)
    print(f"[archie] messages: {result.get('messages', [])}", file=sys.stderr)
    # Emit the last AI text to stderr so it shows in daemon logs.
    for message in reversed(result.get("messages", [])):
        if getattr(message, "type", None) == "ai" and getattr(message, "content", None):
            print(f"[archie] {message.content}", file=sys.stderr)
            return
    else:
        print("[archie] wake finished with no AI message", file=sys.stderr)


async def main() -> None:
    print("[archie] boot: building agent", file=sys.stderr)

    # AsyncSqliteSaver.from_conn_string is an async context manager (confirmed
    # from vendor/deepagents/libs/cli/deepagents_cli/sessions.py line 1030).
    # Keep it open for the entire process lifetime so the checkpointer DB
    # connection is available across all wakes.
    async with AsyncSqliteSaver.from_conn_string(
        "/store/langgraph-checkpoint.db"
    ) as checkpointer:
        # State dict holds the lazily-initialised agent (None until first wake).
        # Model construction (no network call) happens here; MCP connection is
        # deferred to first wake so the boot path is independent of MCP availability.
        state: dict = {"agent": None}
        print("[archie] boot: ready, awaiting wake envelopes on stdin", file=sys.stderr)

        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader()
        reader_protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: reader_protocol, sys.stdin)

        while True:
            line = await reader.readline()
            if not line:
                print("[archie] EOF on stdin — clean exit", file=sys.stderr)
                return
            text = line.decode().strip()
            if not text:
                continue
            try:
                envelope = json.loads(text)
            except json.JSONDecodeError as e:
                print(f"[archie] invalid wake envelope: {e}", file=sys.stderr)
                continue
            try:
                await handle_wake(state, checkpointer, envelope)
            except Exception as e:
                print(f"[archie] handle_wake failed: {e!r}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
