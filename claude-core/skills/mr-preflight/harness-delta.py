import os, re, subprocess, sys

test_re = sys.argv[1]
new_tests = sys.argv[2:]

SIGNALS = [
    ("runner", r"from ['\"]vitest['\"]|from ['\"]@jest/globals['\"]|^import pytest|^import unittest|require\(['\"]jest"),
    ("render", r"@testing-library/react|@testing-library/vue|shallow\(|mount\(|render\("),
    ("base", r"^class \w+\((\w+\.)?(TestCase|APITestCase|SimpleTestCase)\)|^describe\("),
    ("fixture", r"@pytest\.fixture|beforeEach\(|def setUp|@given|createTestingPinia"),
    ("mock", r"\bvi\.(mock|fn|spyOn)\(|jest\.(mock|fn|spyOn)\(|unittest\.mock|MagicMock|monkeypatch"),
    ("assert", r"expect\(|self\.assert|\bassert\b"),
    ("property", r"hypothesis|@given|fast-check|\bfc\."),
]


def fingerprint(path):
    try:
        txt = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    return {name for name, rx in SIGNALS if re.search(rx, txt, re.M)}


def siblings(tf):
    d = os.path.dirname(tf) or "."
    ext = tf.rsplit(".", 1)[-1]
    found = []
    for probe in (d, os.path.dirname(d) or "."):
        try:
            names = subprocess.run(["rg", "--files", probe], capture_output=True, text=True, timeout=30).stdout.split()
        except Exception:
            names = []
        for n in names:
            if n == tf or not n.endswith("." + ext):
                continue
            if re.search(test_re, n):
                found.append(n)
        if len(found) >= 3:
            break
    return found[:6]


for tf in new_tests:
    mine = fingerprint(tf)
    if mine is None:
        continue
    sibs = siblings(tf)
    if not sibs:
        print("    %s :: NO SIBLINGS in %s — take the harness from the repo test root" % (tf, os.path.dirname(tf)))
        continue
    prints = [fingerprint(s) for s in sibs]
    prints = [p for p in prints if p is not None]
    if not prints:
        continue
    consensus = {n for n, _ in SIGNALS if sum(n in p for p in prints) * 2 > len(prints)}
    missing = sorted(consensus - mine)
    extra = sorted(mine - consensus - {"property"})
    ref = os.path.basename(sibs[0])
    if not missing and not extra:
        print("    %s :: MATCHES sibling consensus [%s] (n=%d, ref %s)" % (tf, "+".join(sorted(consensus)), len(prints), ref))
    else:
        print("    %s :: DIVERGES vs consensus [%s] (n=%d, ref %s) missing=%s extra=%s"
              % (tf, "+".join(sorted(consensus)), len(prints), ref,
                 ",".join(missing) or "-", ",".join(extra) or "-"))
