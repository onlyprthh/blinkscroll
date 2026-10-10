import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "setup" / "auto_setup.py"
SPEC = importlib.util.spec_from_file_location("blinkscroll_auto_setup", MODULE_PATH)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class AutoSetupTests(unittest.TestCase):
    def test_running_detection_does_not_match_crashpad_substrings(self):
        setup.SYSTEM = "Linux"
        with patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess(
            args=[], returncode=0, stdout="chrome_crashpad\nbash\n", stderr=""
        )):
            self.assertFalse(setup.is_running("chrome"))

    def test_running_detection_matches_exact_browser_process(self):
        setup.SYSTEM = "Linux"
        with patch.object(setup.subprocess, "run", return_value=subprocess.CompletedProcess(
            args=[], returncode=0, stdout="chrome\nchrome_crashpad\n", stderr=""
        )):
            self.assertTrue(setup.is_running("chrome"))

    def test_permanent_flag_is_idempotent(self):
        source = "[Desktop Entry]\nExec=/usr/bin/google-chrome %U\n"
        once = setup.update_extension_argument(source, True, "/tmp/BlinkScroll")
        twice = setup.update_extension_argument(once, True, "/tmp/BlinkScroll")
        self.assertEqual(once, twice)
        self.assertEqual(once.count("--load-extension=/tmp/BlinkScroll"), 1)

    def test_undo_preserves_other_extension_flags(self):
        source = ('[Desktop Entry]\nExec=/usr/bin/google-chrome '
                  '--load-extension=/opt/other --load-extension=/tmp/BlinkScroll %U\n')
        result = setup.update_extension_argument(source, False, "/tmp/BlinkScroll")
        self.assertIn("--load-extension=/opt/other", result)
        self.assertNotIn("--load-extension=/tmp/BlinkScroll", result)

    def test_space_in_path_quotes_full_desktop_exec_token(self):
        source = "[Desktop Entry]\nExec=/usr/bin/google-chrome %U\n"
        result = setup.update_extension_argument(source, True, "/tmp/Blink Scroll")
        self.assertIn('"--load-extension=/tmp/Blink Scroll"', result)

    def test_quoted_browser_executable_path_is_preserved(self):
        source = '[Desktop Entry]\nExec="/opt/Google Chrome/chrome" %U\n'
        result = setup.update_extension_argument(source, True, "/tmp/BlinkScroll")
        self.assertIn('Exec="/opt/Google Chrome/chrome" --load-extension=/tmp/BlinkScroll %U', result)

    def test_enabling_without_exec_line_fails_cleanly(self):
        self.assertIsNone(setup.update_extension_argument("[Desktop Entry]\nName=Chrome\n", True,
                                                         "/tmp/BlinkScroll"))


if __name__ == "__main__":
    unittest.main()
