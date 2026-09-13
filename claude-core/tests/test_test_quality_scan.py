#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("test_quality_scan",
                                              ROOT / "scripts" / "test-quality-scan.py")
scan = importlib.util.module_from_spec(SPEC)
sys.modules["test_quality_scan"] = scan
SPEC.loader.exec_module(scan)


def checks(path: str, source: str) -> list[str]:
    return [f["check"] for f in scan.scan_file(path, source)]


class FileSelection(unittest.TestCase):
    def test_python_and_typescript_test_names_are_recognised(self) -> None:
        for path in ("tests/test_x.py", "pkg/x_test.py", "tests/conftest.py",
                     "src/a.test.ts", "src/a.spec.tsx", "src/a.test.js"):
            self.assertTrue(scan.is_test_file(path), path)

    def test_production_files_are_not_test_files(self) -> None:
        for path in ("src/app.py", "src/testing_helpers.py", "src/a.ts", "docs/testing.md"):
            self.assertFalse(scan.is_test_file(path), path)


class AssertionFree(unittest.TestCase):
    def test_a_test_with_no_assertion_is_flagged(self) -> None:
        source = "def test_thing():\n    result = compute()\n    print(result)\n"
        self.assertEqual(checks("tests/test_a.py", source), ["assertion-free"])

    def test_a_plain_assert_statement_satisfies_the_check(self) -> None:
        source = "def test_thing():\n    assert compute() == 3\n"
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_unittest_style_assertions_satisfy_the_check(self) -> None:
        source = ("import unittest\n"
                  "class T(unittest.TestCase):\n"
                  "    def test_thing(self):\n"
                  "        self.assertEqual(compute(), 3)\n")
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_a_raises_context_manager_counts_as_asserting(self) -> None:
        source = ("import pytest\n"
                  "def test_thing():\n"
                  "    with pytest.raises(ValueError):\n"
                  "        compute()\n")
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_delegating_to_an_asserting_helper_counts(self) -> None:
        source = ("def test_thing():\n"
                  "    assert_round_trip(atom())\n")
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_a_non_test_function_without_assertions_is_ignored(self) -> None:
        source = "def helper():\n    return 1\n"
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_async_tests_are_checked_too(self) -> None:
        source = "async def test_thing():\n    await compute()\n"
        self.assertEqual(checks("tests/test_a.py", source), ["assertion-free"])


class MockOnly(unittest.TestCase):
    def test_a_test_asserting_only_on_call_records_is_flagged(self) -> None:
        source = ("def test_thing(mocker):\n"
                  "    client = mocker.Mock()\n"
                  "    run(client)\n"
                  "    client.send.assert_called_once()\n")
        self.assertEqual(checks("tests/test_a.py", source), ["mock-only"])

    def test_a_call_record_plus_a_state_assertion_is_accepted(self) -> None:
        source = ("def test_thing(mocker):\n"
                  "    client = mocker.Mock()\n"
                  "    result = run(client)\n"
                  "    client.send.assert_called_once()\n"
                  "    assert result == 3\n")
        self.assertEqual(checks("tests/test_a.py", source), [])


class Seeds(unittest.TestCase):
    def test_multiline_fast_check_seed_is_blocking(self) -> None:
        findings = scan.scan_text("a.test.ts", "fc.configureGlobal({\n  numRuns: 20,\n  seed: 42\n});\n")
        self.assertEqual([(f["check"], f["line"], f["blocking"]) for f in findings], [("pinned-seed", 1, True)])

    def test_unconditionally_loaded_named_profile_is_blocking(self) -> None:
        source = "settings.register_profile('ci',\n  derandomize=True)\nsettings.load_profile('ci')\n"
        self.assertTrue(scan.scan_text("conftest.py", source)[0]["blocking"])
        replay = source.replace("settings.load_profile('ci')", "if os.getenv('REPLAY'):\n  settings.load_profile('ci')")
        self.assertFalse(scan.scan_text("conftest.py", replay)[0]["blocking"])
        for selection in ('os.getenv("HYPOTHESIS_PROFILE", "ci")', 'os.environ.get("HYPOTHESIS_PROFILE", "ci")', 'os.getenv("HYPOTHESIS_PROFILE") or "ci"'):
            with self.subTest(selection=selection):
                default = source.replace("settings.load_profile('ci')", f"settings.load_profile({selection})")
                self.assertTrue(scan.scan_text("conftest.py", default)[0]["blocking"])

    def test_multiline_comments_and_templates_do_not_pin_execution(self) -> None:
        source = "/* fc.configureGlobal({\nseed: 42 }); */\nconst example = `fc.configureGlobal({\n seed: 42 });`;\n"
        self.assertEqual(scan.scan_text("a.test.ts", source), [])

    def test_a_literal_random_seed_is_flagged(self) -> None:
        self.assertIn("pinned-seed", checks("tests/test_a.py",
                                            "import random\ndef test_x():\n    random.seed(1234)\n    assert 1\n"))

    def test_hypothesis_derandomize_is_flagged(self) -> None:
        source = ("from hypothesis import settings\n"
                  "PROPERTY = settings(max_examples=50, derandomize=True)\n")
        self.assertEqual(checks("tests/test_a.py", source), ["pinned-seed"])

    def test_derandomize_inside_a_named_profile_is_advisory_not_blocking(self) -> None:
        source = ("from hypothesis import settings\n"
                  "settings.register_profile('mutation', derandomize=True, max_examples=100)\n")
        findings = scan.scan_file("tests/conftest.py", source)
        self.assertEqual([f["check"] for f in findings], ["pinned-seed"])
        self.assertFalse(findings[0]["blocking"])

    def test_derandomize_inside_the_default_profile_stays_blocking(self) -> None:
        source = ("from hypothesis import settings\n"
                  "settings.register_profile('default', derandomize=True)\n")
        findings = scan.scan_file("tests/conftest.py", source)
        self.assertTrue(findings[0]["blocking"])

    def test_a_named_profile_does_not_excuse_a_seed_outside_it(self) -> None:
        source = ("from hypothesis import settings\n"
                  "settings.register_profile('mutation', derandomize=True)\n"
                  "PROPERTY = settings(derandomize=True)\n")
        findings = scan.scan_file("tests/conftest.py", source)
        self.assertEqual([f["blocking"] for f in findings], [False, True])

    def test_a_fast_check_seed_read_from_the_environment_is_not_flagged(self) -> None:
        source = ("const seed = Number(process.env.FC_SEED);\n"
                  "fc.configureGlobal({ numRuns: 200, seed: seed });\n")
        self.assertEqual(checks("src/a.test.ts", source), [])

    def test_a_fast_check_literal_seed_is_still_flagged(self) -> None:
        source = "fc.configureGlobal({ numRuns: 200, seed: 42 });\n"
        self.assertIn("pinned-seed", checks("src/a.test.ts", source))

    def test_a_seed_from_a_variable_is_not_flagged(self) -> None:
        source = "import random\ndef test_x():\n    random.seed(seed_from_env)\n    assert 1\n"
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_a_seed_inside_a_comment_is_not_flagged(self) -> None:
        source = "# random.seed(1) would pin the suite\ndef test_x():\n    assert 1\n"
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_a_seed_quoted_inside_a_string_is_not_flagged(self) -> None:
        source = ('FIXTURE = "import random\\nrandom.seed(1234)\\n"\n'
                  "def test_x():\n    assert FIXTURE\n")
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_masking_preserves_line_numbers(self) -> None:
        source = ('BLOB = """\nrandom.seed(1)\n"""\n'
                  "import random\n"
                  "def test_x():\n    random.seed(7)\n    assert 1\n")
        findings = scan.scan_file("tests/test_a.py", source)
        self.assertEqual([(f["check"], f["line"]) for f in findings], [("pinned-seed", 6)])

    def test_a_seed_inside_a_typescript_string_is_not_flagged(self) -> None:
        source = "const doc = 'fc.assert(x, { seed: 42 })';\nit('x', () => { expect(doc).toBeTruthy(); });"
        self.assertEqual(checks("src/a.test.ts", source), [])

    def test_fast_check_seed_is_flagged_in_typescript(self) -> None:
        source = "it('holds', () => { fc.assert(fc.property(fc.nat(), n => n >= 0), { seed: 42 }); expect(1).toBe(1); });"
        self.assertIn("pinned-seed", checks("src/a.test.ts", source))


class RetryPolicies(unittest.TestCase):
    def test_a_vitest_retry_is_flagged(self) -> None:
        self.assertIn("retry-masks-flake", checks("vitest.config.ts", "export default { test: { retry: 2 } }"))

    def test_retry_zero_is_not_flagged(self) -> None:
        self.assertEqual(checks("vitest.config.ts", "export default { test: { retry: 0 } }"), [])

    def test_a_flaky_marker_is_flagged(self) -> None:
        source = "@pytest.mark.flaky\ndef test_x():\n    assert 1\n"
        self.assertIn("retry-masks-flake", checks("tests/test_a.py", source))


class Skips(unittest.TestCase):
    def test_a_skip_without_a_reason_is_advisory(self) -> None:
        source = "import pytest\n@pytest.mark.skip\ndef test_x():\n    assert 1\n"
        findings = scan.scan_file("tests/test_a.py", source)
        self.assertEqual([f["check"] for f in findings], ["silent-skip"])
        self.assertFalse(findings[0]["blocking"])

    def test_a_skipped_placeholder_is_not_also_reported_assertion_free(self) -> None:
        source = ("import pytest\n"
                  "@pytest.mark.skip(reason='hypothesis is not installed')\n"
                  "def test_property_suite_requires_hypothesis():\n    ...\n")
        self.assertEqual(checks("tests/test_a.py", source), [])

    def test_an_unskipped_placeholder_is_still_reported(self) -> None:
        source = "def test_property_suite_requires_hypothesis():\n    ...\n"
        self.assertEqual(checks("tests/test_a.py", source), ["assertion-free"])

    def test_a_skip_with_a_reason_is_accepted(self) -> None:
        source = "import pytest\n@pytest.mark.skip(reason='needs AWS')\ndef test_x():\n    assert 1\n"
        self.assertEqual(checks("tests/test_a.py", source), [])


class TypeScript(unittest.TestCase):
    def test_an_it_block_with_no_expect_is_flagged(self) -> None:
        source = "it('does something', () => {\n  render(<App />);\n});\n"
        self.assertEqual(checks("src/a.test.tsx", source), ["assertion-free"])

    def test_an_it_block_with_expect_is_accepted(self) -> None:
        source = "it('does something', () => {\n  expect(render(<App />)).toBeTruthy();\n});\n"
        self.assertEqual(checks("src/a.test.tsx", source), [])

    def test_a_to_throw_assertion_is_accepted(self) -> None:
        source = "it('throws', () => {\n  chai.expect(() => boom()).to.throw();\n});\n"
        self.assertEqual(checks("src/a.test.ts", source), [])


class Robustness(unittest.TestCase):
    def test_an_unparseable_python_file_is_reported_but_not_blocking(self) -> None:
        findings = scan.scan_file("tests/test_a.py", "def test_x(:\n")
        self.assertEqual([f["check"] for f in findings], ["unparseable"])
        self.assertFalse(findings[0]["blocking"])

    def test_findings_are_ordered_by_file_then_line(self) -> None:
        source = ("def test_a():\n    pass\n"
                  "def test_b():\n    pass\n")
        lines = [f["line"] for f in scan.scan_file("tests/test_a.py", source)]
        self.assertEqual(lines, sorted(lines))


class RealRepositoryFiles(unittest.TestCase):
    """The scanner must not flag this repository's own passing tests."""

    def test_the_claude_core_test_suite_has_no_blocking_findings(self) -> None:
        offenders = []
        for path in sorted((ROOT / "tests").glob("test_*.py")):
            rel = str(path.relative_to(ROOT))
            for finding in scan.scan_file(rel, path.read_text(encoding="utf-8")):
                if finding["blocking"]:
                    offenders.append(f"{finding['file']}:{finding['line']} {finding['check']}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
