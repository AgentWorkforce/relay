import json
from pathlib import Path
import tempfile
import unittest

from soak import classify, dead_letter_reasons, message_for, payload_for


class SoakComparisonTest(unittest.TestCase):
    def test_detects_byte_loss_position(self):
        expected = "head-middle-tail"
        self.assertEqual(classify(expected, expected), "exact")
        self.assertEqual(classify(expected, "-middle-tail"), "tail_only")
        self.assertEqual(classify(expected, "head-middle-"), "head_only")
        self.assertEqual(classify(expected, "middle"), "middle_only")
        self.assertEqual(classify(expected, "other"), "corrupt")

    def test_sequence_changes_payload(self):
        self.assertEqual(len(payload_for(1, 150, 1890).encode()), 150)
        self.assertNotEqual(payload_for(1, 150, 1890), payload_for(2, 150, 1890))
        ident, message = message_for(1, 150, 1890)
        self.assertTrue(message.startswith(f"SOAK-ID: {ident}"))
        self.assertTrue(message.endswith(f"END-SOAK-ID: {ident}"))
        self.assertIn(payload_for(1, 150, 1890), message)
        self.assertEqual(classify(message, message[len(ident):]), "tail_only")

    def test_queued_failure_is_observed_from_broker_dead_letter(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / "dead-letters-test.json").write_text(json.dumps([
                {"delivery": {"event_id": "evt_1"}, "reason": "injection_too_large"}
            ]))
            self.assertEqual(dead_letter_reasons(state), {"evt_1": "injection_too_large"})


if __name__ == "__main__":
    unittest.main()
