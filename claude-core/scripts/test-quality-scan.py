#!/usr/bin/env python3
"""Scan test files for the ways a test can pass while asserting nothing.

    test-quality-scan.py <path>...          scan the named files
    test-quality-scan.py --diff <base>      scan the test files a diff touches

Python is parsed with `ast`, so "does this test assert anything" is answered on
the syntax tree rather than by grepping. TypeScript and JavaScript are matched
textually, which is an approximation and is labelled as one.

Checks, blocking unless marked advisory:
  pinned-seed          a fixed seed on the default exploration path, which
                       replays one example sequence forever. A seed inside a
                       named profile, or read from the environment for replay,
                       is reproduction machinery and is reported as advisory
  assertion-free       a test with no assertion and no helper that asserts
  mock-only            every assertion is about a mock's call record, so the
                       code under test could return anything
  retry-masks-flake    a retry/rerun policy in test config, which converts a
                       real intermittent failure into a green run
  silent-skip          a skip or xfail with no reason (advisory)
"""
from __future__ import annotations

import argparse
import ast
import re
import subprocess
import sys
from pathlib import Path

BLOCKING = {"pinned-seed", "assertion-free", "mock-only", "retry-masks-flake"}

PY_TEST = re.compile(r"(^|/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$")
TS_TEST = re.compile(r"\.(test|spec)\.(ts|tsx|js|jsx|mjs)$")

SEED_PATTERNS = (
    (r"\brandom\.seed\s*\(\s*[0-9]", "random.seed with a literal"),
    (r"\bnp(?:\.random)?\.random\.seed\s*\(\s*[0-9]", "numpy seed with a literal"),
    (r"\bnumpy\.random\.seed\s*\(\s*[0-9]", "numpy seed with a literal"),
    (r"\btorch\.manual_seed\s*\(\s*[0-9]", "torch seed with a literal"),
    (r"\bderandomize\s*=\s*True", "Hypothesis derandomize=True pins the example sequence"),
    (r"\bsettings\([^)]*\bseed\s*=", "Hypothesis settings(seed=...) pins the run"),
    (r"\bfc\.configureGlobal\([^)]*\bseed\s*:\s*[0-9-]", "fast-check global seed"),
    (r"\bfc\.assert\([^;]*\bseed\s*:\s*[0-9-]", "fast-check seed pinned at the call site"),
    (r"\bfaker\.seed(?:_instance)?\s*\(\s*[0-9]", "faker seed with a literal"),
)

RETRY_PATTERNS = (
    (r"\bretry\s*:\s*[1-9]", "vitest/jest retry in config"),
    (r"--reruns[ =]\s*[1-9]", "pytest-rerunfailures reruns"),
    (r"@(?:pytest\.mark\.)?flaky\b", "flaky marker"),
    (r"\btest\.retry\s*\(\s*[1-9]", "per-test retry"),
)

ASSERT_CALL_HINTS = ("assert", "check", "verify", "expect", "raises", "must")
MOCK_ASSERT = re.compile(r"^assert_(called|any_call|has_calls|not_called|awaited)")


def is_test_file(path: str) -> bool:
    return bool(PY_TEST.search(path) or TS_TEST.search(path))


def _calls_asserting_helper(node: ast.AST) -> bool:
    for child in ast.walk(node):
        if isinstance(child, ast.Call):
            name = ""
            if isinstance(child.func, ast.Name):
                name = child.func.id
            elif isinstance(child.func, ast.Attribute):
                name = child.func.attr
            lowered = name.lstrip("_").lower()
            if any(lowered.startswith(hint) for hint in ASSERT_CALL_HINTS):
                return True
        if isinstance(child, (ast.With, ast.AsyncWith)):
            for item in child.items:
                source = ast.dump(item.context_expr)
                if "raises" in source or "assert" in source.lower():
                    return True
    return False


def _assert_targets(node: ast.AST) -> list[str]:
    """Attribute names of every assertion-ish call in the function."""
    targets = []
    for child in ast.walk(node):
        if isinstance(child, ast.Assert):
            targets.append("assert")
        elif isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute):
            if child.func.attr.startswith("assert"):
                targets.append(child.func.attr)
    return targets


def scan_python(path: str, source: str) -> list[dict]:
    findings: list[dict] = []
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [{"check": "unparseable", "file": path, "line": exc.lineno or 1,
                 "detail": f"cannot parse: {exc.msg}", "blocking": False}]

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.name.startswith("test"):
            continue

        decorators = " ".join(ast.dump(d) for d in node.decorator_list)
        skipped = "skip" in decorators or "xfail" in decorators

        targets = _assert_targets(node)
        if skipped:
            pass          # a test that cannot run asserts nothing by construction
        elif not targets and not _calls_asserting_helper(node):
            findings.append({"check": "assertion-free", "file": path, "line": node.lineno,
                             "detail": f"{node.name} asserts nothing", "blocking": True})
        elif targets and all(MOCK_ASSERT.match(t) for t in targets):
            findings.append({"check": "mock-only", "file": path, "line": node.lineno,
                             "detail": f"{node.name} only asserts on mock call records "
                                       f"({', '.join(sorted(set(targets)))})",
                             "blocking": True})

        for decorator in node.decorator_list:
            source_text = ast.dump(decorator)
            if ("skip" in source_text or "xfail" in source_text) and "reason" not in source_text:
                findings.append({"check": "silent-skip", "file": path, "line": node.lineno,
                                 "detail": f"{node.name} is skipped with no reason",
                                 "blocking": False})
    return findings


def mask_strings(path: str, source: str) -> str:
    """Blank the contents of string literals, keeping line and column numbers.

    Without this the scanner flags its own fixtures: a seed call quoted inside a
    test's input string is not a seed call.
    """
    if path.endswith(".py"):
        import io
        import tokenize

        try:
            tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
        except (tokenize.TokenError, IndentationError, SyntaxError):
            return source
        lines = source.splitlines(keepends=True)
        for token in tokens:
            if token.type not in (tokenize.STRING, getattr(tokenize, "FSTRING_MIDDLE", -1)):
                continue
            (start_row, start_col), (end_row, end_col) = token.start, token.end
            for row in range(start_row, end_row + 1):
                line = lines[row - 1]
                begin = start_col if row == start_row else 0
                finish = end_col if row == end_row else len(line.rstrip("\n"))
                lines[row - 1] = (line[:begin]
                                  + " " * max(0, finish - begin)
                                  + line[finish:])
        return "".join(lines)

    def blank(match: re.Match) -> str:
        return match.group(0)[0] + " " * (len(match.group(0)) - 2) + match.group(0)[-1]

    return re.sub(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"", blank, source)


def named_profile_lines(source: str) -> set:
    """Line numbers inside a `register_profile("<name>", ...)` that is not the default. Pure.

    A seed pinned there is a named reproduction or mutation profile, which is
    the supported way to replay a counterexample. Pinning the default
    exploration path is the defect.
    """
    inside: set = set()
    for match in re.finditer(r"register_profile\s*\(\s*(['\"])(?P<name>[^'\"]*)\1", source):
        if match.group("name") in ("", "default"):
            continue
        depth, index = 0, source.index("(", match.start())
        while index < len(source):
            if source[index] == "(":
                depth += 1
            elif source[index] == ")":
                depth -= 1
                if depth == 0:
                    break
            index += 1
        first = source.count("\n", 0, match.start()) + 1
        last = source.count("\n", 0, index) + 1
        inside.update(range(first, last + 1))
    return inside


def scan_text(path: str, source: str) -> list[dict]:
    """Language-agnostic textual checks: seeds and retry policies."""
    findings: list[dict] = []
    lines = mask_strings(path, source).splitlines()
    replay_profile = named_profile_lines(source)
    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        for pattern, detail in SEED_PATTERNS:
            if re.search(pattern, line):
                named = index in replay_profile
                findings.append({"check": "pinned-seed", "file": path, "line": index,
                                 "detail": detail + (" (named profile, advisory)" if named else ""),
                                 "blocking": not named})
        for pattern, detail in RETRY_PATTERNS:
            if re.search(pattern, line):
                findings.append({"check": "retry-masks-flake", "file": path, "line": index,
                                 "detail": detail, "blocking": True})
    return findings


def scan_typescript(path: str, source: str) -> list[dict]:
    """Approximate: an `it`/`test` block with no `expect(`/`assert` in its body."""
    findings: list[dict] = []
    for match in re.finditer(r"\b(it|test)(?:\.\w+)?\s*\(\s*(['\"`])(.+?)\2\s*,", source):
        start = source.find("{", match.end())
        if start == -1:
            continue
        depth, index = 0, start
        while index < len(source):
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
                if depth == 0:
                    break
            index += 1
        body = source[start:index]
        if not re.search(r"\bexpect\s*\(|\bassert\b|\.toThrow|chai\.", body):
            line = source[:match.start()].count("\n") + 1
            findings.append({"check": "assertion-free", "file": path, "line": line,
                             "detail": f"{match.group(3)[:60]!r} asserts nothing (textual match)",
                             "blocking": True})
    return findings


def scan_file(path: str, source: str) -> list[dict]:
    findings = scan_text(path, source)
    if path.endswith(".py"):
        findings += scan_python(path, source)
    elif TS_TEST.search(path):
        findings += scan_typescript(path, source)
    return sorted(findings, key=lambda f: (f["file"], f["line"], f["check"]))


def diff_files(base: str) -> list[str]:
    out = subprocess.run(("git", "diff", "--name-only", "--diff-filter=d", base),
                         capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--diff", metavar="BASE")
    parser.add_argument("--all", action="store_true",
                        help="report advisory findings as failures too")
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args(argv)

    paths = args.paths
    if args.diff:
        paths = diff_files(args.diff)
    candidates = [p for p in paths if is_test_file(p) or p.endswith(("vitest.config.ts",
                                                                     "jest.config.js",
                                                                     "pytest.ini",
                                                                     "pyproject.toml",
                                                                     "setup.cfg"))]
    findings: list[dict] = []
    for path in candidates:
        file_path = Path(path)
        if not file_path.exists():
            continue
        findings += scan_file(path, file_path.read_text(encoding="utf-8", errors="replace"))

    blocking = [f for f in findings if f["blocking"]]
    for finding in findings:
        mark = "BLOCK" if finding["blocking"] else "note "
        print(f"{mark} {finding['check']:<18} {finding['file']}:{finding['line']}  {finding['detail']}")
    print(f"\nscanned {len(candidates)} test file(s): "
          f"{len(blocking)} blocking, {len(findings) - len(blocking)} advisory")
    return 1 if blocking or (args.all and findings) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
