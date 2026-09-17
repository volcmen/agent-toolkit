"""Optional background director that asks a small model for a scene mood."""
import json
import os
import re
import shutil
import subprocess
import sys
import time

MOTIFS = (
    "forest", "skyline", "reef", "circuit", "office",
    "sakura", "kana", "shrine", "hangar", "dojo", "hud",
    "studyroom", "sparkfield", "dust",
)
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
TIMEOUT_SECONDS = 40
PROMPT_LIMIT = 900


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def top_languages(files, limit=3):
    if not isinstance(files, dict):
        return []
    items = sorted(files.items(), key=lambda kv: (-kv[1], kv[0]))
    return [name for name, _ in items[:limit]]


def build_prompt(journey, session):
    journey = journey or {}
    session = session or {}
    repo = journey.get("repo") or "a project"
    languages = top_languages(journey.get("files"))
    words = journey.get("words") or []
    last_prompt = session.get("prompt") or journey.get("last_prompt") or ""
    parts = [
        "Reply with STRICT JSON only, no prose, matching this shape:",
        '{"motif":"' + "|".join(MOTIFS) + '","palette":["#rrggbb"x5],'
        '"tempo":0.5-2.0,"title":"<=24 chars","mood":"one word"}.',
        "Repo: {}.".format(repo),
        "Motifs: forest skyline reef circuit office (calm); sakura kana shrine hangar dojo hud"
        " studyroom sparkfield dust (anime: blossoms, katakana rain, shrine, mecha, training arc,"
        " status window, study room, constellation, dust sprites).",
    ]
    if languages:
        parts.append("Top languages: {}.".format(", ".join(languages)))
    if words:
        parts.append("Recent prompt words: {}.".format(", ".join(words)))
    if last_prompt:
        parts.append("Last prompt: {}".format(last_prompt))
    prompt = " ".join(parts)
    return prompt[:PROMPT_LIMIT]


def clamp(value, low, high):
    return max(low, min(high, value))


def validate_mood(candidate):
    if not isinstance(candidate, dict):
        return None
    motif = candidate.get("motif")
    palette = candidate.get("palette")
    tempo = candidate.get("tempo")
    title = candidate.get("title")
    mood = candidate.get("mood")
    if motif not in MOTIFS:
        return None
    if not isinstance(palette, list) or len(palette) != 5:
        return None
    if not all(isinstance(color, str) and HEX_RE.match(color) for color in palette):
        return None
    try:
        tempo = float(tempo)
    except (TypeError, ValueError):
        return None
    tempo = clamp(tempo, 0.5, 2.0)
    if not isinstance(title, str) or not title:
        return None
    if not isinstance(mood, str) or not mood:
        return None
    return {
        "motif": motif,
        "palette": [color.lower() for color in palette],
        "tempo": tempo,
        "title": title[:24],
        "mood": mood.split()[0][:24],
    }


def parse_claude_output(raw):
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if isinstance(data, dict) and isinstance(data.get("result"), str):
        try:
            return json.loads(data["result"])
        except Exception:
            return None
    return None


def parse_codex_output(raw):
    text = raw.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except Exception:
        return None


def run_claude(prompt):
    binary = shutil.which("claude")
    if not binary:
        return None, None
    try:
        result = subprocess.run(
            [binary, "-p", prompt, "--model", "haiku", "--output-format", "json", "--max-turns", "1"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except Exception:
        return None, None
    if result.returncode != 0:
        return None, None
    return parse_claude_output(result.stdout), "haiku"


def run_codex(prompt):
    binary = shutil.which("codex")
    if not binary:
        return None, None
    try:
        result = subprocess.run(
            [binary, "exec", "-q", prompt],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except Exception:
        return None, None
    if result.returncode != 0:
        return None, None
    return parse_codex_output(result.stdout), "codex"


def write_mood(state_dir, mood, source):
    payload = {
        "v": 1,
        "ts": time.time(),
        "source": source,
        "motif": mood["motif"],
        "palette": mood["palette"],
        "tempo": mood["tempo"],
        "title": mood["title"],
        "mood": mood["mood"],
    }
    os.makedirs(state_dir, exist_ok=True)
    target = os.path.join(state_dir, "mood.json")
    tmp = os.path.join(state_dir, ".mood.json.{}.tmp".format(os.getpid()))
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(tmp, target)


def log_line(state_dir, message):
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(os.path.join(state_dir, "fx.log"), "a", encoding="utf-8") as handle:
            handle.write("{:.3f} sbg_director {}\n".format(time.time(), message))
    except OSError:
        pass


def extract_fake(argv):
    for index, item in enumerate(argv):
        if item == "--fake" and index + 1 < len(argv):
            return argv[index + 1]
    return None


def main(argv):
    state_dir = os.environ.get("SBG_STATE")
    if not state_dir:
        return 0

    journey = read_json(os.path.join(state_dir, "journey.json"))
    session = read_json(os.path.join(state_dir, "session.json"))
    prompt = build_prompt(journey, session)

    if "--dry-run" in argv:
        print(prompt)
        return 0

    fake = extract_fake(argv)
    if fake is not None:
        try:
            candidate = json.loads(fake)
        except Exception:
            log_line(state_dir, "fail invalid-fake-json")
            return 0
        mood = validate_mood(candidate)
        if mood is None:
            log_line(state_dir, "fail invalid-fake-mood")
            return 0
        write_mood(state_dir, mood, "haiku")
        log_line(state_dir, "ok fake")
        return 0

    candidate, source = run_claude(prompt)
    if candidate is None:
        candidate, source = run_codex(prompt)
    mood = validate_mood(candidate)
    if mood is None:
        log_line(state_dir, "fail no-valid-mood")
        return 0
    write_mood(state_dir, mood, source or "haiku")
    log_line(state_dir, "ok {}".format(source))
    return 0


try:
    sys.exit(main(sys.argv[1:]))
except Exception:
    sys.exit(0)
