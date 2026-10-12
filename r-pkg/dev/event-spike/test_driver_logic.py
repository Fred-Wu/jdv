"""Platform-independent checks for observation versus unverified disposition."""
import unittest
from io import BytesIO
from types import SimpleNamespace
from pathlib import Path
import tempfile
from unittest.mock import patch

from windows_runner import (READLINE_PROMPT, READLINE_REPLY, Session, classify_outer_gate_interrupt,
                            emitted_count, readline_expression, readline_reply_accepted,
                            readline_wait_observation, rterm_case)


# Condensed records from the failed Windows run: echoed code is not a prompt,
# and OUTER_DONE preceded the host's answer. No R implementation is reproduced.
ECHO_ONLY = '> local({readline("SPIKE_READLINE> "); spike_marker("OUTER_DONE")})\n'
PREMATURE = ECHO_ONLY + "SPIKE_READLINE> \nSPIKE|OUTER_DONE\n> SPIKE_NATIVE|RECEIVED|a\nanswer\nError: object 'answer' not found\n"
NORMAL_WAIT = ('> local({readline(paste0("SPIKE_", "READLINE> "))})\n'
               'SPIKE|READLINE_ENTER\nSPIKE_READLINE> SPIKE_NATIVE|RECEIVED|a\n'
               'SPIKE_NATIVE|GATE_SINGLE|7|1\n')
NORMAL_REPLY = NORMAL_WAIT + 'answer\nSPIKE|READLINE_ANSWER|' + READLINE_REPLY + '\nSPIKE|OUTER_DONE\n'


class ConsoleTransport(unittest.TestCase):
    def test_conpty_uses_one_enter_for_each_input_newline(self):
        writes = []
        session = Session.__new__(Session)
        session.driver = "ConPTY / fake transport"
        session.proc = SimpleNamespace(write=writes.append)
        for expression in ("command\n", "command\r\n", "command\r"):
            with self.subTest(expression=expression):
                session.send(expression)
                self.assertEqual(writes[-1], "command\r")
                self.assertEqual(sum(c in "\r\n" for c in writes[-1]), 1)
        session.send("first\r\nsecond\rlast\n")
        self.assertEqual(writes[-1], "first\rsecond\rlast\r")

    def test_old_crlf_submission_fails_single_enter_contract(self):
        old_payload = "command\n".replace("\n", "\r\n")
        self.assertNotEqual(old_payload, "command\r")
        self.assertEqual(sum(c in "\r\n" for c in old_payload), 2)

    def test_pipe_input_keeps_one_lf(self):
        for expression in ("command\n", "command\r\n", "command\r"):
            with self.subTest(expression=expression):
                stream = BytesIO()
                session = Session.__new__(Session)
                session.driver = "Rterm --ess / fake pipe"
                session.proc = SimpleNamespace(stdin=stream)
                session.send(expression)
                self.assertEqual(stream.getvalue(), b"command\n")


class ReadlineEvidence(unittest.TestCase):
    def test_input_constructs_prompt_at_runtime(self):
        self.assertNotIn(READLINE_PROMPT, readline_expression())

    def test_echo_only_is_neither_prompt_nor_completion(self):
        state = readline_wait_observation(ECHO_ONLY)
        self.assertFalse(state["prompt_seen"])
        self.assertFalse(state["premature_completion"])

    def test_actual_early_completion_is_driver_failure_evidence(self):
        state = readline_wait_observation(PREMATURE)
        self.assertTrue(state["prompt_seen"])
        self.assertTrue(state["premature_completion"])
        self.assertFalse(readline_reply_accepted(PREMATURE, ""))

    def test_waiting_prompt_can_prefix_native_records(self):
        state = readline_wait_observation(NORMAL_WAIT)
        self.assertTrue(state["entry_seen"])
        self.assertTrue(state["prompt_seen"])
        self.assertFalse(state["premature_completion"])
        self.assertEqual(emitted_count(NORMAL_WAIT, "SPIKE_NATIVE|RECEIVED|a"), 1)

    def test_normal_answer_requires_state_and_emitted_confirmation(self):
        self.assertTrue(readline_reply_accepted(NORMAL_REPLY, READLINE_REPLY))
        self.assertFalse(readline_reply_accepted(NORMAL_REPLY, ""))
        self.assertFalse(readline_reply_accepted(NORMAL_WAIT, READLINE_REPLY))

    def test_premature_completion_fails_case_without_claiming_gate_counterexample(self):
        def fake_init(session, *args):
            session.text = ""
            session.driver = "ConPTY / transcript fixture"
            session.frontend_state = {"interactive": True}
            session.fallback_reason = None
        def fake_send(session, expression):
            session.text += PREMATURE
        with tempfile.TemporaryDirectory(prefix="jdv-readline-driver-") as folder:
            with patch.object(Session, "__init__", fake_init), \
                 patch.object(Session, "send", fake_send), patch.object(Session, "read_for"), \
                 patch.object(Session, "wait_marker"), patch.object(Session, "wait_readline_prompt"), \
                 patch.object(Session, "close"):
                result = rterm_case("unused", "unused", "gated_restore", "readline", Path(folder) / "case")
        self.assertFalse(result["passed"])
        self.assertFalse(result["assertions"]["readline_wait_open_before_answer"])
        self.assertIn("Driver premature readline completion", result["error"])
        self.assertNotIn("framed_wait_defers", result["assertions"])


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
