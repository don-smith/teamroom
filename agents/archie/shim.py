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
  TEAMROOM_PROVIDER       — model provider (lm-studio, openai, openrouter, ollama, anthropic)
  TEAMROOM_MODEL_BASE_URL — daemon proxy URL (OpenAI-compatible for local/openai providers)
  TEAMROOM_MODEL_API_TOKEN — proxy-minted token for OpenAI-compatible providers
  ANTHROPIC_BASE_URL      — daemon proxy URL (Anthropic-shape)
  ANTHROPIC_AUTH_TOKEN    — proxy-minted token for Anthropic
  TEAMROOM_MODEL          — e.g. "deepseek/deepseek-v4-flash"

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
from deepagents.profiles import _HarnessProfile, _register_harness_profile
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver


LOCAL_MODEL_DEEPAGENTS_PROMPT = """You are a DeepAgents-based Team Room agent.
Use available tools when needed, then answer concisely. For mail wakes, inspect
mail, read requested codebase files before making architectural claims, and
reply in-thread. Cite file paths when relevant. Prefer the smallest useful
inspection over broad codebase exploration."""

PER_WAKE_RECURSION_LIMIT = int(os.environ.get("TEAMROOM_ARCHIE_RECURSION_LIMIT", "16"))
MAX_BUILD_RETRIES = 3


# The default DeepAgents harness prompt and subagent/todo tools are too large
# for some locally-loaded LM Studio models. Archie only needs mail + filesystem
# for M6 acceptance, so compact the OpenAI-compatible prompt surface inside this
# container without patching vendored DeepAgents.
_register_harness_profile(
    "openai",
    _HarnessProfile(
        base_system_prompt=LOCAL_MODEL_DEEPAGENTS_PROMPT,
        excluded_tools=frozenset({"task", "write_todos", "compact_conversation"}),
    ),
)


def sanitize_sender(value: str) -> str:
    """Escape/strip a mail.from value before interpolating it into prompts."""
    return (
        value.replace("\r", " ")
        .replace("\n", " ")
        .replace("\t", " ")
        .replace("\\", "\\\\")
        .replace("`", "\\`")
        .strip()[:200]
    )


def build_wake_prompt(envelope: dict) -> str:
    events = envelope.get("events") if isinstance(envelope, dict) else None
    mail_events = [e for e in events or [] if isinstance(e, dict) and e.get("type") == "mail.delivered"]
    if not mail_events:
        return (
            "A Team Room wake fired, but no structured mail event was included. "
            "Use mail_list exactly once with unreadOnly=true. If there is actionable mail, "
            "read it with mail_get and respond with mail_reply when useful. If nothing is "
            "actionable, end without sending mail."
        )

    event = mail_events[-1]
    message_id = event.get("messageId", "unknown")
    thread_id = event.get("threadId", "unknown")
    sender = sanitize_sender(str(event.get("from", "unknown")))
    reply_expected = bool(event.get("replyExpected"))

    if reply_expected:
        return (
            "A Team Room mail event requires a reply. "
            f"Message id: {message_id}. Thread id: {thread_id}. From: {sender}. "
            "Use mail_get exactly once with the message id above. For codebase/architecture "
            "questions, read at most four highly relevant files; for this Archie runtime/provider "
            "area, prefer agents/archie/agent.yaml, agents/archie/shim.py, "
            "src/agent-spec/build-spec.ts, src/modules/model-proxy/model-proxy.ts, and "
            "src/types.ts. Then call mail_reply with that same message id. Do not continue "
            "investigating once you have one concise observation. Final assistant text is "
            "diagnostic only and is not delivered to Team Room; the turn is complete only "
            "after mail_reply succeeds."
        )

    return (
        "A Team Room mail event arrived without a required reply. "
        f"Message id: {message_id}. Thread id: {thread_id}. From: {sender}. "
        "Use mail_get if you need to read it. Send mail only if doing so adds value; "
        "otherwise end without replying."
    )


def mail_event(envelope: dict) -> dict | None:
    events = envelope.get("events") if isinstance(envelope, dict) else None
    for event in reversed(events or []):
        if isinstance(event, dict) and event.get("type") == "mail.delivered":
            return event
    return None


def checkpoint_thread_id(envelope: dict) -> str:
    event = mail_event(envelope)
    if event and event.get("threadId"):
        return f"mail-thread-{event['threadId']}"
    return "archie-main"


def emit_log(level: str, msg: str, **fields) -> None:
    print(json.dumps({"type": "log", "level": level, "msg": msg, **fields}), flush=True)


def has_successful_mail_reply(result: dict) -> bool:
    for message in result.get("messages", []):
        if getattr(message, "type", None) == "tool" and getattr(message, "name", None) == "mail_reply":
            return True
    return False


def invalid_tool_calls(result: dict) -> list[dict]:
    calls = []
    for message in result.get("messages", []):
        for call in getattr(message, "invalid_tool_calls", []) or []:
            if not isinstance(call, dict):
                calls.append({"error": str(call)})
                continue
            calls.append(
                {
                    "id": call.get("id"),
                    "name": call.get("name"),
                    "error": call.get("error"),
                }
            )
    return calls


def final_ai_text(result: dict) -> str | None:
    for message in reversed(result.get("messages", [])):
        if getattr(message, "type", None) == "ai" and getattr(message, "content", None):
            content = message.content
            return content if isinstance(content, str) else str(content)
    return None


async def fallback_mail_reply(message_id: str, body: str) -> None:
    mcp_url = os.environ["TEAMROOM_MCP_URL"]
    mcp_token = os.environ["TEAMROOM_MCP_TOKEN"]
    request = {
        "jsonrpc": "2.0",
        "id": "archie-fallback-mail-reply",
        "method": "tools/call",
        "params": {
            "name": "mail.reply",
            "arguments": {"id": message_id, "body": body},
        },
    }
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            mcp_url,
            json=request,
            headers={
                "accept": "application/json, text/event-stream",
                "x-teamroom-mcp-token": mcp_token,
            },
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict) and payload.get("error"):
            raise RuntimeError(f"fallback mail.reply failed: {payload['error']}")


def load_system_prompt() -> str:
    path = Path("/AGENTS.md")
    if path.exists():
        return path.read_text()
    return "You are Archie, Team Room's architect."


def make_model():
    """Build the LLM instance for Archie's configured model provider.

    Team Room owns provider routing through the local model proxy. DeepAgents is
    the runtime; it should not imply Anthropic. OpenAI-compatible providers
    (LM Studio, OpenAI, OpenRouter, Ollama) use ChatOpenAI against TEAMROOM_MODEL_BASE_URL.
    Anthropic uses ChatAnthropic against ANTHROPIC_BASE_URL.

    OpenRouter is selected only when TEAMROOM_PROVIDER=openrouter, not by
    ambient OPENROUTER_* env vars. This keeps provider choice explicit in
    agent.yaml.
    """
    provider = os.environ["TEAMROOM_PROVIDER"]
    model_id = os.environ["TEAMROOM_MODEL"]

    if provider in {"lm-studio", "openai", "openrouter", "ollama"}:
        # LangChain's ChatOpenAI treats base_url as the OpenAI API root and
        # appends /chat/completions, so include /v1 here to reach Team Room's
        # OpenAI-compatible proxy route: /v1/chat/completions.
        base_url = os.environ["TEAMROOM_MODEL_BASE_URL"].rstrip("/") + "/v1"
        return ChatOpenAI(
            model=model_id,
            base_url=base_url,
            api_key=os.environ["TEAMROOM_MODEL_API_TOKEN"],
            max_tokens=512,
            temperature=0,
        )

    if provider == "anthropic":
        # Route through the daemon's Anthropic-shape proxy. This must use
        # ChatAnthropic, not ChatOpenAI: Team Room's Anthropic adapter forwards
        # Anthropic `/v1/messages` requests, not OpenAI `/chat/completions`.
        return ChatAnthropic(
            model_name=model_id,
            base_url=os.environ["ANTHROPIC_BASE_URL"],
            api_key=os.environ["ANTHROPIC_AUTH_TOKEN"],
        )

    raise RuntimeError(f"unsupported TEAMROOM_PROVIDER for Archie: {provider}")


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
    # Build agent on first wake; cache in state dict for subsequent wakes.
    if state.get("agent") is None:
        print(
            "[archie] first wake: connecting to MCP and building agent", file=sys.stderr
        )
        try:
            state["agent"] = await build_agent(checkpointer)
            state["build_failures"] = 0
            print("[archie] first wake: agent ready", file=sys.stderr)
        except Exception as err:
            state["build_failures"] = state.get("build_failures", 0) + 1
            raise RuntimeError(
                f"first-wake agent build failed (attempt {state['build_failures']}/{MAX_BUILD_RETRIES}): {err}"
            ) from err

    agent = state["agent"]

    thread_id = checkpoint_thread_id(envelope)
    wake_prompt = build_wake_prompt(envelope)
    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": PER_WAKE_RECURSION_LIMIT,
    }
    print(f"[archie] invoking agent with prompt: {wake_prompt}", file=sys.stderr)
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": wake_prompt}]},
        config=config,
    )
    # Log full result for debugging
    print(f"[archie] result keys: {result.keys()}", file=sys.stderr)
    print(f"[archie] messages: {result.get('messages', [])}", file=sys.stderr)

    text = final_ai_text(result)
    event = mail_event(envelope)
    invalid_calls = invalid_tool_calls(result)
    if invalid_calls:
        emit_log(
            "warn",
            "agent.tool_call.invalid",
            messageId=event.get("messageId") if event else None,
            threadId=event.get("threadId") if event else None,
            invalidToolCalls=invalid_calls,
        )

    if (
        event
        and event.get("replyExpected")
        and event.get("messageId")
        and text
        and not has_successful_mail_reply(result)
    ):
        print(
            "[archie] replyExpected wake ended without successful mail_reply; sending fallback mail.reply",
            file=sys.stderr,
        )
        emit_log(
            "warn",
            "agent.reply_required.fallback_used",
            messageId=event.get("messageId"),
            threadId=event.get("threadId"),
            reason="replyExpected wake ended without successful mail_reply",
        )
        await fallback_mail_reply(str(event["messageId"]), text)
        print("[archie] fallback mail.reply sent", file=sys.stderr)

    # Emit the last AI text to stderr so it shows in daemon logs.
    if text:
        print(f"[archie] {text}", file=sys.stderr)
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
                emit_log(
                    "warn",
                    "agent.wake_failed",
                    error=str(e),
                    buildFailures=state.get("build_failures", 0),
                )
                if state.get("build_failures", 0) >= MAX_BUILD_RETRIES:
                    print(
                        f"[archie] build failed {state['build_failures']} times; exiting so daemon respawn can engage",
                        file=sys.stderr,
                    )
                    sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
