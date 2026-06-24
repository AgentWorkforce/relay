"""Tests for communicate mode types (TDD - red phase).

Tests cover:
- Message dataclass (creation, immutability, defaults)
- RelayConfig dataclass (defaults, env var resolution)
- Exception types (RelayConnectionError, RelayConfigError, RelayAuthError)
- MessageCallback type alias compatibility
"""

import asyncio
import dataclasses

import pytest

from agent_relay.communicate.types import (
    Message,
    MessageCallback,
    RelayAuthError,
    RelayConfig,
    RelayConfigError,
    RelayConnectionError,
)


# ---------------------------------------------------------------------------
# Message dataclass
# ---------------------------------------------------------------------------


class TestMessage:
    """Tests for the Message frozen dataclass."""

    def test_create_with_required_fields_only(self):
        msg = Message(sender="Alice", text="Hello")
        assert msg.sender == "Alice"
        assert msg.text == "Hello"

    def test_optional_fields_default_to_none(self):
        msg = Message(sender="Alice", text="Hello")
        assert msg.channel is None
        assert msg.thread_id is None
        assert msg.timestamp is None
        assert msg.message_id is None

    def test_create_with_all_fields(self):
        msg = Message(
            sender="Bob",
            text="Hi there",
            channel="general",
            thread_id="thread-123",
            timestamp=1710300000.0,
            message_id="msg-456",
        )
        assert msg.sender == "Bob"
        assert msg.text == "Hi there"
        assert msg.channel == "general"
        assert msg.thread_id == "thread-123"
        assert msg.timestamp == 1710300000.0
        assert msg.message_id == "msg-456"

    def test_is_frozen_cannot_set_sender(self):
        msg = Message(sender="Alice", text="Hello")
        with pytest.raises(dataclasses.FrozenInstanceError):
            msg.sender = "Eve"  # type: ignore[misc]

    def test_is_frozen_cannot_set_text(self):
        msg = Message(sender="Alice", text="Hello")
        with pytest.raises(dataclasses.FrozenInstanceError):
            msg.text = "Tampered"  # type: ignore[misc]

    def test_is_frozen_cannot_set_optional_field(self):
        msg = Message(sender="Alice", text="Hello")
        with pytest.raises(dataclasses.FrozenInstanceError):
            msg.channel = "secret"  # type: ignore[misc]

    def test_is_dataclass(self):
        assert dataclasses.is_dataclass(Message)

    def test_equality_same_values(self):
        a = Message(sender="Alice", text="Hi")
        b = Message(sender="Alice", text="Hi")
        assert a == b

    def test_equality_different_values(self):
        a = Message(sender="Alice", text="Hi")
        b = Message(sender="Bob", text="Hi")
        assert a != b

    def test_channel_none_means_dm(self):
        """When channel is None, the message is a direct message."""
        msg = Message(sender="Alice", text="DM content")
        assert msg.channel is None

    def test_channel_set_means_channel_message(self):
        msg = Message(sender="Alice", text="Channel content", channel="general")
        assert msg.channel == "general"


# ---------------------------------------------------------------------------
# RelayConfig dataclass
# ---------------------------------------------------------------------------


class TestRelayConfig:
    """Tests for the RelayConfig dataclass with env var defaults."""

    def test_all_defaults(self, monkeypatch):
        monkeypatch.delenv("RELAY_WORKSPACE", raising=False)
        monkeypatch.delenv("RELAY_API_KEY", raising=False)
        monkeypatch.delenv("RELAY_BASE_URL", raising=False)

        config = RelayConfig()
        assert config.workspace is None
        assert config.api_key is None
        assert config.base_url is None
        assert config.channels == ["general"]
        assert config.poll_interval_ms == 1000
        assert config.auto_cleanup is True

    def test_explicit_values_override_defaults(self):
        config = RelayConfig(
            workspace="my-ws",
            api_key="key-123",
            base_url="https://custom.api.dev",
            channels=["dev", "ops"],
            poll_interval_ms=500,
            auto_cleanup=False,
        )
        assert config.workspace == "my-ws"
        assert config.api_key == "key-123"
        assert config.base_url == "https://custom.api.dev"
        assert config.channels == ["dev", "ops"]
        assert config.poll_interval_ms == 500
        assert config.auto_cleanup is False

    def test_channels_default_is_independent_per_instance(self):
        """Each RelayConfig gets its own channels list (no shared mutable default)."""
        a = RelayConfig()
        b = RelayConfig()
        a.channels.append("extra")
        assert "extra" not in b.channels

    def test_env_var_workspace(self, monkeypatch):
        monkeypatch.setenv("RELAY_WORKSPACE", "env-workspace")
        config = RelayConfig()
        assert config.workspace == "env-workspace"

    def test_env_var_api_key(self, monkeypatch):
        monkeypatch.setenv("RELAY_API_KEY", "env-key-abc")
        config = RelayConfig()
        assert config.api_key == "env-key-abc"

    def test_env_var_base_url(self, monkeypatch):
        monkeypatch.setenv("RELAY_BASE_URL", "https://env.api.dev")
        config = RelayConfig()
        assert config.base_url == "https://env.api.dev"

    def test_base_url_default_when_no_env(self, monkeypatch):
        """When RELAY_BASE_URL is not set, base_url defaults to the Relaycast cloud URL."""
        monkeypatch.delenv("RELAY_BASE_URL", raising=False)
        config = RelayConfig()
        # base_url should resolve to the default cloud URL when accessed
        # The exact resolution may happen at init or lazily; either None or the default is acceptable
        # but the resolved value should be "https://api.relaycast.dev"
        assert config.base_url is None or config.base_url == "https://api.relaycast.dev"

    def test_explicit_value_overrides_env_var(self, monkeypatch):
        monkeypatch.setenv("RELAY_WORKSPACE", "env-workspace")
        config = RelayConfig(workspace="explicit-workspace")
        assert config.workspace == "explicit-workspace"

    def test_is_dataclass(self):
        assert dataclasses.is_dataclass(RelayConfig)

    def test_is_not_frozen(self):
        """RelayConfig should be mutable (not frozen)."""
        config = RelayConfig()
        config.workspace = "updated"
        assert config.workspace == "updated"


# ---------------------------------------------------------------------------
# Exception types
# ---------------------------------------------------------------------------


class TestRelayConnectionError:
    """Tests for RelayConnectionError which stores status_code and message."""

    def test_inherits_from_exception(self):
        assert issubclass(RelayConnectionError, Exception)

    def test_stores_status_code_and_message(self):
        err = RelayConnectionError(status_code=500, message="Internal Server Error")
        assert err.status_code == 500
        assert err.message == "Internal Server Error"

    def test_str_contains_status_and_message(self):
        err = RelayConnectionError(status_code=503, message="Service Unavailable")
        text = str(err)
        assert "503" in text
        assert "Service Unavailable" in text

    def test_different_status_codes(self):
        for code in [400, 404, 429, 500, 502, 503]:
            err = RelayConnectionError(status_code=code, message=f"Error {code}")
            assert err.status_code == code


class TestRelayConfigError:
    """Tests for RelayConfigError which signals missing configuration."""

    def test_inherits_from_exception(self):
        assert issubclass(RelayConfigError, Exception)

    def test_has_descriptive_message(self):
        err = RelayConfigError("RELAY_API_KEY environment variable is required")
        assert "RELAY_API_KEY" in str(err)

    def test_message_accessible(self):
        msg = "Missing RELAY_WORKSPACE. Set the environment variable or pass workspace= to RelayConfig."
        err = RelayConfigError(msg)
        assert str(err) == msg


class TestRelayAuthError:
    """Tests for RelayAuthError which signals HTTP 401 responses."""

    def test_inherits_from_exception(self):
        assert issubclass(RelayAuthError, Exception)

    def test_message(self):
        err = RelayAuthError("Invalid API key")
        assert "Invalid API key" in str(err)

    def test_inherits_from_relay_connection_error_or_exception(self):
        """RelayAuthError should be catchable as a general exception."""
        err = RelayAuthError("Unauthorized")
        assert isinstance(err, Exception)


# ---------------------------------------------------------------------------
# MessageCallback type alias
# ---------------------------------------------------------------------------


class TestMessageCallback:
    """Tests that both sync and async callables satisfy MessageCallback."""

    def test_sync_callable_is_valid(self):
        """A synchronous function that takes a Message and returns None should be valid."""
        received: list[Message] = []

        def handler(msg: Message) -> None:
            received.append(msg)

        # Verify the callable works as expected
        callback: MessageCallback = handler
        msg = Message(sender="Alice", text="Test")
        callback(msg)
        assert len(received) == 1
        assert received[0].sender == "Alice"

    async def test_async_callable_is_valid(self):
        """An async function that takes a Message and returns None should be valid."""
        received: list[Message] = []

        async def handler(msg: Message) -> None:
            received.append(msg)

        callback: MessageCallback = handler
        msg = Message(sender="Bob", text="Async test")
        result = callback(msg)
        # If it returns a coroutine, await it
        if asyncio.iscoroutine(result):
            await result
        assert len(received) == 1
        assert received[0].sender == "Bob"

    def test_lambda_callable_is_valid(self):
        """A lambda that takes a Message should work as a callback."""
        results: list[str] = []
        callback: MessageCallback = lambda msg: results.append(msg.text)
        callback(Message(sender="X", text="lambda-test"))
        assert results == ["lambda-test"]
