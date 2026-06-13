"""Unit tests for the Archie DeepAgents shim.

These tests are intended to run inside the Archie Docker image where the
DeepAgents/LangChain dependencies are available, or in any Python environment
where the Dockerfile's `pip install` dependencies have been installed.

Run locally (if deps are installed):
    python -m pytest agents/archie/shim_test.py

Run via Docker after building the Archie image:
    docker run --rm -v "$PWD/agents/archie/shim_test.py:/app/shim_test.py" \
        teamroom-agent-archie:latest python -m pytest /app/shim_test.py
"""

from __future__ import annotations

import json
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shim import (
    build_wake_prompt,
    fallback_mail_reply,
    make_model,
    sanitize_sender,
)


class TestSanitizeSender:
    def test_leaves_clean_address_unchanged(self):
        assert sanitize_sender("channel:cli:don") == "channel:cli:don"
        assert sanitize_sender("agent:archie") == "agent:archie"

    def test_replaces_newlines_and_carriage_returns_with_space(self):
        assert sanitize_sender("channel:cli:foo\nbar") == "channel:cli:foo bar"
        assert sanitize_sender("channel:cli:foo\rbar") == "channel:cli:foo bar"

    def test_escapes_backticks_and_backslashes(self):
        assert sanitize_sender("channel:cli:`whoami`") == "channel:cli:\\`whoami\\`"
        assert sanitize_sender("channel:cli:C:\\path") == "channel:cli:C:\\\\path"

    def test_trims_whitespace(self):
        assert sanitize_sender("  channel:cli:don  ") == "channel:cli:don"

    def test_caps_length(self):
        long = "a" * 300
        assert len(sanitize_sender(long)) == 200


class TestBuildWakePrompt:
    def _envelope(self, event=None):
        return {"type": "wake", "events": [event] if event else []}

    def test_no_events_returns_default_prompt(self):
        prompt = build_wake_prompt(self._envelope())
        assert "no structured mail event" in prompt

    def test_non_mail_events_returns_default_prompt(self):
        event = {"type": "agent.activity", "agentId": "archie"}
        prompt = build_wake_prompt(self._envelope(event))
        assert "no structured mail event" in prompt

    def test_reply_expected_prompt(self):
        event = {
            "type": "mail.delivered",
            "messageId": "msg-1",
            "threadId": "thread-1",
            "from": "channel:cli:don",
            "replyExpected": True,
        }
        prompt = build_wake_prompt(self._envelope(event))
        assert "requires a reply" in prompt
        assert "msg-1" in prompt
        assert "thread-1" in prompt
        assert "channel:cli:don" in prompt
        assert "mail_reply" in prompt

    def test_no_reply_expected_prompt(self):
        event = {
            "type": "mail.delivered",
            "messageId": "msg-2",
            "threadId": "thread-2",
            "from": "channel:cli:don",
            "replyExpected": False,
        }
        prompt = build_wake_prompt(self._envelope(event))
        assert "without a required reply" in prompt
        assert "msg-2" in prompt
        assert "thread-2" in prompt
        assert "mail_reply" not in prompt

    def test_sanitizes_from_field(self):
        event = {
            "type": "mail.delivered",
            "messageId": "msg-3",
            "threadId": "thread-3",
            "from": "channel:cli:`inject`\nextra",
            "replyExpected": True,
        }
        prompt = build_wake_prompt(self._envelope(event))
        assert "`inject`" not in prompt
        assert "\\`inject\\`" in prompt
        assert "\n" not in prompt

    def test_uses_last_mail_event(self):
        events = [
            {"type": "mail.delivered", "messageId": "first", "replyExpected": False},
            {"type": "mail.delivered", "messageId": "last", "replyExpected": True, "from": "agent:other"},
        ]
        prompt = build_wake_prompt({"type": "wake", "events": events})
        assert "last" in prompt
        assert "requires a reply" in prompt


class TestMakeModel:
    @pytest.fixture(autouse=True)
    def clear_provider_env(self, monkeypatch):
        """Ensure each test starts with no provider env vars set."""
        for key in (
            "TEAMROOM_PROVIDER",
            "TEAMROOM_MODEL",
            "TEAMROOM_MODEL_BASE_URL",
            "TEAMROOM_MODEL_API_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
        ):
            monkeypatch.delenv(key, raising=False)

    def _set_openai_env(self, monkeypatch, provider):
        monkeypatch.setenv("TEAMROOM_PROVIDER", provider)
        monkeypatch.setenv("TEAMROOM_MODEL", "some-model")
        monkeypatch.setenv("TEAMROOM_MODEL_BASE_URL", "http://proxy/")
        monkeypatch.setenv("TEAMROOM_MODEL_API_TOKEN", "token-123")

    def test_openrouter_uses_chat_openai(self, monkeypatch):
        from langchain_openai import ChatOpenAI

        self._set_openai_env(monkeypatch, "openrouter")
        model = make_model()
        assert isinstance(model, ChatOpenAI)
        assert model.model_name == "some-model"
        assert model.openai_api_base == "http://proxy/v1"
        assert model.openai_api_key.get_secret_value() == "token-123"
        assert model.max_tokens == 512
        assert model.temperature == 0

    def test_lm_studio_uses_chat_openai(self, monkeypatch):
        from langchain_openai import ChatOpenAI

        self._set_openai_env(monkeypatch, "lm-studio")
        model = make_model()
        assert isinstance(model, ChatOpenAI)

    def test_openai_uses_chat_openai(self, monkeypatch):
        from langchain_openai import ChatOpenAI

        self._set_openai_env(monkeypatch, "openai")
        model = make_model()
        assert isinstance(model, ChatOpenAI)

    def test_ollama_uses_chat_openai(self, monkeypatch):
        from langchain_openai import ChatOpenAI

        self._set_openai_env(monkeypatch, "ollama")
        model = make_model()
        assert isinstance(model, ChatOpenAI)

    def test_anthropic_uses_chat_anthropic(self, monkeypatch):
        from langchain_anthropic import ChatAnthropic

        monkeypatch.setenv("TEAMROOM_PROVIDER", "anthropic")
        monkeypatch.setenv("TEAMROOM_MODEL", "claude-opus-4")
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://anthropic-proxy/")
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "anthropic-token")
        model = make_model()
        assert isinstance(model, ChatAnthropic)
        assert model.model == "claude-opus-4"
        assert model.anthropic_api_url == "http://anthropic-proxy/"
        assert model.anthropic_api_key.get_secret_value() == "anthropic-token"

    def test_unsupported_provider_raises(self, monkeypatch):
        monkeypatch.setenv("TEAMROOM_PROVIDER", "unknown-provider")
        monkeypatch.setenv("TEAMROOM_MODEL", "some-model")
        with pytest.raises(RuntimeError, match="unsupported TEAMROOM_PROVIDER"):
            make_model()


class TestFallbackMailReply:
    @pytest.fixture(autouse=True)
    def set_mcp_env(self, monkeypatch):
        monkeypatch.setenv("TEAMROOM_MCP_URL", "http://mcp.test/mcp")
        monkeypatch.setenv("TEAMROOM_MCP_TOKEN", "mcp-token")

    @pytest.mark.asyncio
    async def test_posts_json_rpc_request(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {"result": {"ok": True}}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        mock_client.__aexit__.return_value = False

        with patch("shim.httpx.AsyncClient", return_value=mock_client):
            await fallback_mail_reply("msg-1", "hello")

        mock_client.__aenter__.return_value.post.assert_awaited_once()
        call_args = mock_client.__aenter__.return_value.post.call_args
        assert call_args.kwargs["json"]["method"] == "tools/call"
        assert call_args.kwargs["json"]["params"]["name"] == "mail.reply"
        assert call_args.kwargs["json"]["params"]["arguments"]["id"] == "msg-1"
        assert call_args.kwargs["json"]["params"]["arguments"]["body"] == "hello"
        assert call_args.kwargs["headers"]["x-teamroom-mcp-token"] == "mcp-token"

    @pytest.mark.asyncio
    async def test_rpc_error_raises(self):
        mock_response = MagicMock()
        mock_response.json.return_value = {"error": {"code": -32600, "message": "bad"}}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_response)
        mock_client.__aexit__.return_value = False

        with patch("shim.httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="fallback mail.reply failed"):
                await fallback_mail_reply("msg-1", "hello")
