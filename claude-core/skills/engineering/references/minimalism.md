# Minimalism

The best code is the code never written. Lazy means efficient, not careless:
read the task and every file the change touches, trace the real flow end to
end, then pick the smallest solution that is correct on the edge cases.

## The ladder, in full

Stop at the first rung that holds; when two rungs work, take the higher one.

1. Does this need to exist at all? A speculative need is skipped, in one line.
2. Already in this codebase? A helper, type, or pattern a few files over is
   reused — re-implementing it is the most common slop.
3. Standard library does it? Use it.
4. A native platform feature covers it? `<input type="date">` over a picker
   library, CSS over JavaScript, a database constraint over application code.
5. An already-installed dependency solves it? Use it; never add a new one for
   what a few lines can do.
6. Can it be one line? One line.
7. Only then: the minimum code that works.

## Surgical changes

- Every changed line traces to the request. No abstraction with one
  implementation, no factory for one product, no configuration for a value that
  never changes, no scaffolding "for later", no error handling for impossible
  states, no "flexibility" nobody asked for.
- Deletion over addition; boring over clever — clever is what someone decodes
  at 3 a.m. Fewest files that solve it.
- Match the existing style even where you would choose differently. Remove the
  imports, variables, and functions your change orphaned; mention pre-existing
  dead code, do not delete it unrequested.
- A bug report names a symptom. Grep every caller of the function you are about
  to touch; one guard in the shared function is both the smaller diff and the
  root-cause fix, while a patch on the reported path leaves the other callers broken.
- Two same-size options: take the one that is correct on empty, one-element,
  duplicate, unicode, boundary, and concurrent inputs.

## Not negotiable

Never simplify away input validation at trust boundaries, error handling that
prevents data loss, security controls, accessibility basics, the calibration
knob real hardware needs, or anything the user explicitly asked to keep.

A deliberate shortcut with a known ceiling is recorded in the commit body and
the MR description, or as a tracker item — never as a `ponytail:` marker or
any other comment in source. A
non-trivial branch, loop, parser, or money path ships with the test the
repository's harness expects (`~/.claude/rules/code-style.md`), never with an
ad-hoc `assert` demo in place of one.

When the request is complex, ship the minimal version and question the rest in
the same response: "Did X; Y covers it. Need full X? Say so." Never stall on a
choice you can default.
