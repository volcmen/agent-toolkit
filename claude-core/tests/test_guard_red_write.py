import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("guard", Path(__file__).resolve().parents[1] / "hooks/guard-red-write.py")
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class CommandGuard(unittest.TestCase):
    def test_actual_mutations_are_detected_with_global_options(self):
        for command in (
            "git push -d origin obsolete",
            "git -C /repo config user.email someone@example.com",
            "git --git-dir=/repo/.git push --no-verify origin main",
            "git -c core.hooksPath=/tmp push",
            "git push origin :obsolete",
            "GIT_AUTHOR_NAME=someone git commit -m change",
            "bash -c 'git push --delete origin obsolete'",
            "bash -lc 'git push --no-verify origin main'",
            "env -i git push --no-verify origin main",
            "env -u OLD_SETTING git push --no-verify origin main",
            "echo ready\ngit push -d origin obsolete",
        ):
            with self.subTest(command=command):
                self.assertIsNotNone(guard.reason(command))

    def test_dry_runs_read_only_config_and_quoted_documentation_are_allowed(self):
        for command in (
            "git push -n origin main",
            "git -C /repo config --get user.email",
            "git config user.email",
            "printf '%s\\n' 'git push --no-verify origin main'",
            "echo 'GIT_AUTHOR_NAME=someone git commit'",
            "git commit -m 'git push --delete origin obsolete'",
        ):
            with self.subTest(command=command):
                self.assertIsNone(guard.reason(command))

    def test_heredoc_delimiter_must_occupy_its_own_line(self):
        body = "cat <<'EOF'\ntext EOF git push --no-verify\ngit push -d origin example\nEOF\n"
        self.assertIsNone(guard.reason(body))
        self.assertIsNotNone(guard.reason(body + "git push -d origin obsolete\n"))
        self.assertIsNone(guard.reason("cat <<-EOF\n\tgit push -d origin example\n\tEOF\n"))
        self.assertIsNotNone(guard.reason("cat <<- EOF\n\tdocumentation\n\tEOF\ngit push --no-verify origin main\n"))

    def test_unreadable_payload_asks_instead_of_silently_allowing(self):
        import contextlib, io, json
        for payload in ("not json", "[]", '{"tool_input": "string"}'):
            with self.subTest(payload=payload):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(guard.main(io.StringIO(payload)), 0)
                self.assertEqual(json.loads(out.getvalue())["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_clean_payload_stays_silent_and_red_payload_denies(self):
        import contextlib, io, json
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            guard.main(io.StringIO('{"tool_input": {"command": "git status"}}'))
        self.assertEqual(out.getvalue(), "")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            guard.main(io.StringIO('{"tool_input": {"command": "git push --no-verify origin main"}}'))
        self.assertEqual(json.loads(out.getvalue())["hookSpecificOutput"]["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()
