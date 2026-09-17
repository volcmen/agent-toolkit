"""Bundle the standalone world motifs into plugins/fx/world.lua."""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
FX = ROOT / "plugins" / "fx"
MOTIFS = [
    "forest", "skyline", "reef", "circuit", "office",
    "sakura", "kana", "shrine", "hangar", "dojo", "hud",
]
CUT = "\nfunction init(ctx)"

FOOT = """
local MOTIFS = {
%(table)s
}
local ORDER = { %(order)s }

local CTX = nil
local CURRENT = nil
local ACTIVE = nil

local function choose(state)
  local mood = state.mood or {}
  local want = mood.motif
  if type(want) == "string" and MOTIFS[want] then return want end
  local j = state.journey or {}
  local key = j.repo
  if type(key) ~= "string" or key == "" then
    key = tostring((CTX and CTX.seed) or 0)
  end
  local pick = sbg.pick(ORDER, key)
  if type(pick) == "string" and MOTIFS[pick] then return pick end
  return "office"
end

function init(ctx)
  CTX = ctx
  CURRENT, ACTIVE = nil, nil
end

function step(dt, state)
  if CTX == nil then return end
  local want = choose(state)
  if want ~= CURRENT then
    CURRENT = want
    ACTIVE = MOTIFS[want]
    ACTIVE.init(CTX)
  end
  ACTIVE.step(dt, state)
end

function render(fx, state)
  if ACTIVE == nil then return end
  ACTIVE.render(fx, state)
end
"""


def bundle(motifs=MOTIFS):
    parts = []
    for name in motifs:
        source = (FX / f"{name}.lua").read_text(encoding="utf-8")
        body, sep, _ = source.partition(CUT)
        if not sep:
            raise SystemExit(f"{name}.lua has no top-level init(ctx)")
        parts.append("local %s = (function()\n%s\n  return M\nend)()\n\n" % (name.capitalize(), body.rstrip()))
    foot = FOOT % {
        "table": "\n".join("  %s = %s," % (m, m.capitalize()) for m in motifs),
        "order": ", ".join('"%s"' % m for m in motifs),
    }
    return "".join(parts) + foot


def main(argv):
    text = bundle()
    if "--check" in argv:
        current = (FX / "world.lua").read_text(encoding="utf-8")
        if current != text:
            print("world.lua is stale; run scripts/world/bundle.py", file=sys.stderr)
            return 1
        print("world.lua up to date")
        return 0
    (FX / "world.lua").write_text(text, encoding="utf-8")
    print("world.lua: %d lines, %d motifs" % (text.count("\n"), len(MOTIFS)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
