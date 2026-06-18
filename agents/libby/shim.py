#!/usr/bin/env python3
"""
Libby container entrypoint.

Reads {"type":"wake","events":[...]} JSON envelopes from stdin, one per line.
On each wake, invokes the DeepAgents graph with a "check your inbox" prompt;
the graph itself (mail-MCP tools + DeepAgents filesystem tools) does the real
work. Errors are printed to stderr; the wake loop continues.

Environment (injected by Team Room's build-spec.ts):
  TEAMROOM_AGENT_NAME     — "libby"
  TEAMROOM_MCP_URL        — http://host.docker.internal:<port>/mcp
  TEAMROOM_MCP_TOKEN      — bearer for mail-MCP
  TEAMROOM_PROVIDER       — "openrouter"
  TEAMROOM_MODEL_BASE_URL — daemon proxy URL (OpenAI-compatible)
  TEAMROOM_MODEL_API_TOKEN — proxy-minted token
  TEAMROOM_MODEL          — e.g. "deepseek/deepseek-v4-flash"
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from deepagents import create_deep_agent
from deepagents.backends.filesystem import FilesystemBackend
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

LIBBY_PROMPT = """You are Libby, Team Room's librarian. You maintain the team's
knowledge — document decisions, track git history, surface patterns.

Use available tools when needed, then answer concisely. For mail wakes, inspect
mail, read requested files before making claims, and reply in-thread. Cite file
paths when relevant. Prefer focused reading over broad exploration."""

PER_WAKE_RECURSION_LIMIT = int(os.environ.get("TEAMROOM_LIBBY_RECURSION_LIMIT", "16"))
MAX_BUILD_RETRIES = 3


def make_model():
    provider = os.environ["TEAMROOM_PROVIDER"]
    model_id = os.environ["TEAMROOM_MODEL"]

    if provider == "openrouter":
        base_url = os.environ["TEAMROOM_MODEL_BASE_URL"].rstrip("/") + "/v1"
        return ChatOpenAI(
            model=model_id,
            base_url=base_url,
            api_key=os.environ["TEAMROOM_MODEL_API_TOKEN"],
            max_tokens=512,
            temperature=0,
        )

    raise RuntimeError(f"unsupported TEAMROOM_PROVIDER for Libby: {provider}")


async def build_agent(checkpointer: AsyncSqliteSaver):
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

    tools = await mcp_client.get_tools()
    agent = create_deep_agent(
        model=make_model(),
        tools=tools,
        system_prompt=LIBBY_PROMPT,
        backend=FilesystemBackend(root_dir="/codebase", virtual_mode=False),
        checkpointer=checkpointer,
    )
    return agent, mcp_client


def checkpoint_thread_id(envelope: dict) -> str:
    """Derive a stable thread id from the wake envelope."""
    events = envelope.get("events", [])
    for e in events:
        if isinstance(e, dict) and e.get("type") == "mail.delivered":
            return e.get("threadId", "") or e.get("messageId", "default")
    return "default"


async def run_wake(agent, event: dict):
    thread_id = checkpoint_thread_id(event)
    wake_prompt = "You received a Team Room wake notification. Check unread mail first."
    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": PER_WAKE_RECURSION_LIMIT,
    }
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": wake_prompt}]},
        config=config,
    )
    return result


async def main():
    agent_name = os.environ.get("TEAMROOM_AGENT_NAME", "libby")
    checkpointer_path = Path("/store/langgraph-checkpoint.db")
    checkpointer_path.parent.mkdir(parents=True, exist_ok=True)

    agent = None
    mcp_client = None
    consecutive_build_failures = 0

    async with AsyncSqliteSaver.from_conn_string(
        str(checkpointer_path)
    ) as checkpointer:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                envelope = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"libby: invalid JSON on stdin: {e}", file=sys.stderr)
                continue

            if not isinstance(envelope, dict) or envelope.get("type") != "wake":
                print(f"libby: ignoring non-wake envelope", file=sys.stderr)
                continue

            if agent is None:
                try:
                    agent, mcp_client = await build_agent(checkpointer)
                    consecutive_build_failures = 0
                except Exception as e:
                    consecutive_build_failures += 1
                    print(f"libby: build_agent failed (attempt {consecutive_build_failures}/{MAX_BUILD_RETRIES}): {e}", file=sys.stderr)
                    if consecutive_build_failures >= MAX_BUILD_RETRIES:
                        print(f"libby: max build retries reached, exiting", file=sys.stderr)
                        sys.exit(1)
                    continue

            try:
                await run_wake(agent, envelope)
            except Exception as e:
                print(f"libby: wake error: {e}", file=sys.stderr)

    if mcp_client:
        await mcp_client.__aexit__(None, None, None)


if __name__ == "__main__":
    asyncio.run(main())