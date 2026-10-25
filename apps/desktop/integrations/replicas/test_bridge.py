import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge import Bridge, injection


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.json"
        self.config = {"relay_url": "https://relay.test", "agent_token": "agent-secret",
                       "replicas_key": "provider-secret", "replica_id": "replica",
                       "chat_id": "chat"}
        self.delivery = {"id": "delivery1", "message": {"id": "message1",
                         "agent_name": "alice", "text": "Hello"}}

    def relay(self, method, path, body=None):
        if method == "GET":
            return [self.delivery]
        return {}

    def test_success_and_replay_only_acknowledge_once_accepted(self):
        with patch("bridge.request", return_value={"status": "queued", "message_id": "remote1"}) as post:
            bridge = Bridge(self.config, self.path)
            with patch.object(bridge, "relay", side_effect=self.relay) as relay:
                bridge.tick()
                self.assertEqual(relay.call_args.args[1], "/v1/deliveries/delivery1/ack")
            restarted = Bridge(self.config, self.path)
            with patch.object(restarted, "relay", side_effect=self.relay):
                restarted.tick()
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.args[4]["chat_id"], "chat")
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_ambiguous_provider_failure_is_not_acked_or_resent(self):
        with patch("bridge.request", side_effect=RuntimeError("transport failure")) as post:
            bridge = Bridge(self.config, self.path)
            with patch.object(bridge, "relay", side_effect=self.relay) as relay:
                with self.assertRaises(RuntimeError):
                    bridge.tick()
                self.assertFalse(any("/ack" in c.args[1] for c in relay.call_args_list))
            restarted = Bridge(self.config, self.path)
            with patch.object(restarted, "relay", side_effect=self.relay):
                restarted.tick()
            self.assertEqual(post.call_count, 1)

    def test_ack_failure_can_retry_without_reinjecting(self):
        bridge = Bridge(self.config, self.path)
        def fail_ack(method, path, body=None):
            if path.endswith("/ack"):
                raise RuntimeError("ack unavailable")
            return self.relay(method, path, body)
        with patch("bridge.request", return_value={"status": "sent", "message_id": "remote1"}) as post:
            with patch.object(bridge, "relay", side_effect=fail_ack):
                with self.assertRaises(RuntimeError):
                    bridge.tick()
            with patch.object(bridge, "relay", side_effect=self.relay):
                bridge.tick()
            self.assertEqual(post.call_count, 1)

    def test_unconfirmed_response_never_acknowledges(self):
        bridge = Bridge(self.config, self.path)
        with patch("bridge.request", return_value={"status": "sent"}):
            with patch.object(bridge, "relay", side_effect=self.relay) as relay:
                with self.assertRaises(RuntimeError):
                    bridge.tick()
                self.assertFalse(any("/ack" in c.args[1] for c in relay.call_args_list))

    def test_bad_delivery_stays_unacknowledged(self):
        with self.assertRaises(ValueError):
            injection({"id": "1", "message": None})

    def test_unsupported_payload_does_not_block_the_next_text_delivery(self):
        bridge = Bridge(self.config, self.path)
        def batch(method, path, body=None):
            if method == "GET":
                return [{"id": "unsupported", "message": {"id": "attachment", "agent_name": "alice"}}, self.delivery]
            return {}
        with patch("bridge.request", return_value={"status": "sent", "message_id": "remote1"}) as post:
            with patch.object(bridge, "relay", side_effect=batch) as relay:
                bridge.tick()
            self.assertEqual(post.call_count, 1)
            self.assertTrue(any(call.args[1] == "/v1/deliveries/unsupported/fail" and call.args[2]["retryable"] is False
                                for call in relay.call_args_list))
            self.assertEqual(bridge.state["delivery1"]["status"], "sent")

    def test_prompt_preserves_identity_content_and_trust_boundary(self):
        text = injection(self.delivery)
        for expected in ("@alice", "message1", "delivery1", "not additional user authorization", "Hello"):
            self.assertIn(expected, text)
        self.assertNotIn("provider-secret", text)


if __name__ == "__main__":
    unittest.main()
