"""Platform-independent checks for observation versus unverified disposition."""
import unittest

from windows_runner import classify_outer_gate_interrupt


class OuterGateDisposition(unittest.TestCase):
    def test_captured_interrupt_cannot_hide_outer_continuation(self):
        for native in ({"gate_failures": 1, "failed": 0}, {"gate_failures": 0, "failed": 1}):
            with self.subTest(native=native):
                result = classify_outer_gate_interrupt("gated_restore", native, outer_continued=True)
                self.assertEqual(result["status"], "observed")
                self.assertTrue(result["delivery_observed"])
                self.assertFalse(result["propagation_ok"])

    def test_no_delivery_evidence_is_unverified(self):
        result = classify_outer_gate_interrupt("gated_restore", {"gate_failures": 0, "failed": 0}, outer_continued=True)
        self.assertEqual(result["status"], "unverified")
        self.assertFalse(result["delivery_observed"])
        self.assertIsNone(result["propagation_ok"])

    def test_outer_interruption_is_delivery_evidence(self):
        result = classify_outer_gate_interrupt("gated_restore", {"gate_failures": 0, "failed": 0}, outer_continued=False)
        self.assertEqual(result["status"], "observed")
        self.assertTrue(result["propagation_ok"])

    def test_legacy_counterexample_remains_an_observation(self):
        result = classify_outer_gate_interrupt("gated", {"gate_failures": 1, "failed": 0}, outer_continued=True)
        self.assertEqual(result["status"], "observed")
        self.assertTrue(result["delivery_observed"])
        self.assertIsNone(result["propagation_ok"])


if __name__ == "__main__":
    unittest.main()
