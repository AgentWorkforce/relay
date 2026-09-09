"""Exercise the proof entry point with real unittest discovery subprocesses."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "tests/relayflows/cases/fleet-disk-reaper/run.mjs"
)


class ProofRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.target = self.root / "target"
        self.harness = self.root / "harness"
        self.tests = self.harness / "tests" / "fleet"
        self.tests.mkdir(parents=True)
        self.script = self.target / "scripts" / "fleet" / "disk_reaper.py"
        self.script.parent.mkdir(parents=True)
        self.script.write_text(
            "# Target entry point exists; fixtures exercise discovery.\n"
        )
        self.observation = self.root / "observation.json"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # Recent Python releases return nonzero for empty discovery. Reproduce
        # the successful-empty result from older releases too, so this test
        # guards the runner's count check independently of Python's exit policy.
        interpreter = self.bin / "python3"
        interpreter.write_text(
            "#!" + sys.executable + "\n"
            "import subprocess, sys\n"
            "result = subprocess.run([sys.executable, *sys.argv[1:]], capture_output=True, text=True)\n"
            "sys.stdout.write(result.stdout)\n"
            "sys.stderr.write(result.stderr)\n"
            "sys.exit(0 if 'Ran 0 tests' in result.stderr else result.returncode)\n"
        )
        interpreter.chmod(0o700)

    def run_proof(self):
        return subprocess.run(
            ["node", str(RUNNER)],
            cwd=self.root,
            env={
                **os.environ,
                "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                "RELAY_PR_PROOF_ARM": "head",
                "RELAY_PR_PROOF_TARGET_DIR": str(self.target),
                "RELAY_PR_PROOF_HARNESS_DIR": str(self.harness),
                "RELAY_PR_PROOF_RESULT_PATH": str(self.observation),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
            capture_output=True,
            text=True,
            timeout=30,
        )

    def fixture(self, body, name="test_fixture.py"):
        (self.tests / name).write_text("import unittest\n" + body)

    def assert_rejected(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(
            self.observation.exists(), "failed discovery published evidence"
        )

    def test_empty_discovery_never_publishes_fixed(self):
        # Passing meta-tests elsewhere must not replace missing safety tests.
        meta = self.harness / "tests" / "fleet-proof"
        meta.mkdir()
        (meta / "test_meta.py").write_text(
            "import unittest\nclass Meta(unittest.TestCase):\n    def test_ok(self): pass\n"
        )
        result = self.run_proof()
        self.assertIn("Ran 0 tests", result.stderr)
        self.assert_rejected(result)

    def test_renamed_test_module_never_publishes_fixed(self):
        self.fixture(
            "class Fixture(unittest.TestCase):\n    def test_ok(self): pass\n",
            "renamed.py",
        )
        result = self.run_proof()
        self.assertIn("Ran 0 tests", result.stderr)
        self.assert_rejected(result)

    def test_stdout_cannot_forge_positive_discovery_count(self):
        self.fixture("print('Ran 42 tests in 0.001s')\n")
        result = self.run_proof()
        self.assertIn("Ran 42 tests", result.stdout)
        self.assertIn("Ran 0 tests", result.stderr)
        self.assert_rejected(result)

    def test_one_executed_test_publishes_fixed(self):
        self.fixture("class Fixture(unittest.TestCase):\n    def test_ok(self): pass\n")
        result = self.run_proof()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Ran 1 test", result.stderr)
        self.assertEqual(json.loads(self.observation.read_text())["outcome"], "fixed")

    def test_multiple_executed_tests_publish_fixed(self):
        self.fixture(
            "class Fixture(unittest.TestCase):\n    def test_one(self): pass\n    def test_two(self): pass\n"
        )
        result = self.run_proof()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Ran 2 tests", result.stderr)
        self.assertEqual(json.loads(self.observation.read_text())["outcome"], "fixed")

    def test_skipped_test_never_publishes_fixed(self):
        self.fixture(
            "class Fixture(unittest.TestCase):\n    @unittest.skip('fixture')\n    def test_skip(self): pass\n"
        )
        self.assert_rejected(self.run_proof())

    def test_failing_test_never_publishes_fixed(self):
        self.fixture(
            "class Fixture(unittest.TestCase):\n    def test_fail(self): self.fail('fixture')\n"
        )
        self.assert_rejected(self.run_proof())

    def test_missing_discovery_directory_never_publishes_fixed(self):
        self.tests.rmdir()
        self.assert_rejected(self.run_proof())

    def test_missing_target_entry_point_reports_absence(self):
        self.script.unlink()
        result = self.run_proof()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(self.observation.read_text())["outcome"], "absent")


if __name__ == "__main__":
    unittest.main()
