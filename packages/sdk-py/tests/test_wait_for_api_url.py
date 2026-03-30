"""Tests for _wait_for_api_url."""

import asyncio
from unittest.mock import AsyncMock, PropertyMock

import pytest

from agent_relay.client import AgentRelayProcessError, _wait_for_api_url


def _make_process(lines: list[str], returncode: int | None = 0):
    """Create a mock asyncio.subprocess.Process with canned stdout lines."""
    remaining = list(lines)

    async def readline() -> bytes:
        if remaining:
            return (remaining.pop(0) + "\n").encode("utf-8")
        return b""

    process = AsyncMock()
    process.stdout = AsyncMock()
    process.stdout.readline = readline
    type(process).returncode = PropertyMock(return_value=returncode)
    return process


class TestWaitForApiUrl:
    async def test_parses_default_loopback(self):
        process = _make_process([
            "[agent-relay] API listening on http://127.0.0.1:3889",
        ])
        url = await _wait_for_api_url(process, 5000)
        assert url == "http://127.0.0.1:3889"

    async def test_parses_wildcard_bind(self):
        process = _make_process([
            "[agent-relay] API listening on http://0.0.0.0:4000",
        ])
        url = await _wait_for_api_url(process, 5000)
        assert url == "http://0.0.0.0:4000"

    async def test_parses_custom_ip(self):
        process = _make_process([
            "[agent-relay] API listening on http://10.0.1.5:8080",
        ])
        url = await _wait_for_api_url(process, 5000)
        assert url == "http://10.0.1.5:8080"

    async def test_parses_https(self):
        process = _make_process([
            "[agent-relay] API listening on https://broker.example.com:443",
        ])
        url = await _wait_for_api_url(process, 5000)
        assert url == "https://broker.example.com:443"

    async def test_skips_non_matching_lines(self):
        process = _make_process([
            "[agent-relay] Starting broker...",
            "[agent-relay] Loading config",
            "[agent-relay] API listening on http://127.0.0.1:5555",
        ])
        url = await _wait_for_api_url(process, 5000)
        assert url == "http://127.0.0.1:5555"

    async def test_raises_on_process_exit_before_ready(self):
        process = _make_process(
            ["[agent-relay] Starting broker..."],
            returncode=1,
        )
        with pytest.raises(AgentRelayProcessError, match="exited with code 1"):
            await _wait_for_api_url(process, 5000)

    async def test_raises_on_timeout(self):
        async def slow_readline() -> bytes:
            await asyncio.sleep(10)
            return b""

        process = AsyncMock()
        process.stdout = AsyncMock()
        process.stdout.readline = slow_readline
        type(process).returncode = PropertyMock(return_value=None)

        with pytest.raises(AgentRelayProcessError, match="did not report API URL"):
            await _wait_for_api_url(process, 50)

    async def test_ignores_lines_with_colon_but_no_url(self):
        process = _make_process([
            "[agent-relay] config: loaded from /etc/relay.conf",
            "[agent-relay] API listening on http://127.0.0.1:9999",
        ])
        url = await _wait_for_api_url(process, 5000)
        assert url == "http://127.0.0.1:9999"
