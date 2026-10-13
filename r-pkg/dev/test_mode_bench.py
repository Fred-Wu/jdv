"""Focused tests for platform-specific benchmark RSS normalization."""

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("mode-bench.py")
SPEC = importlib.util.spec_from_file_location("mode_bench", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
mode_bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mode_bench)


class Wait4MaxRssTests(unittest.TestCase):
    def test_linux_kib_values_remain_unchanged(self) -> None:
        self.assertEqual(mode_bench.wait4_maxrss_to_kib(12345, "linux"), 12345)

    def test_macos_byte_values_are_rounded_up_to_kib(self) -> None:
        self.assertEqual(mode_bench.wait4_maxrss_to_kib(1024, "darwin"), 1)
        self.assertEqual(mode_bench.wait4_maxrss_to_kib(1025, "darwin"), 2)

    def test_unknown_platform_is_explicitly_unsupported(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "supports Linux and macOS only"):
            mode_bench.wait4_maxrss_to_kib(12345, "freebsd")


if __name__ == "__main__":
    unittest.main()
