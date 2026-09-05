import json, shlex, sys

mode, path = sys.argv[1], sys.argv[2]
d = json.loads(open(path).read() or "null", strict=False)

if mode == "pipeline":
    head = sys.argv[3]
    print(next((p["status"] for p in (d or []) if p["sha"] == head), "NONE"))
    raise SystemExit

g = lambda k, dv="": d.get(k) if d.get(k) is not None else dv
r = d.get("diff_refs") or {}
fields = {
    "target": g("target_branch"),
    "head": g("sha"),
    "base_sha": r.get("base_sha") or "",
    "changes": str(g("changes_count", "?")),
    "draft": str(g("draft")),
    "resolved": str(g("blocking_discussions_resolved")),
    "mstatus": g("merge_status"),
    "nrev": str(len(g("reviewers", []))),
    "state": g("state"),
    "title": g("title"),
    "desc": g("description"),
    "sbranch": g("source_branch"),
}
for k, v in fields.items():
    print("%s=%s" % (k, shlex.quote(str(v))))
