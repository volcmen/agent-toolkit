# Fortress glyph and colour vocabulary

Fortress uses ASCII in every terminal. The host gates every Lua `fx:put` and
`sbg.text` character and substitutes `?` for controls, combining marks, emoji,
wide CJK and unaudited characters. Each distinct substitution is logged once
(up to 256 distinct code points) in `fx.log`.

| Role | Glyph | Colour |
|---|---|---|
| Wall / unexcavated vein | `#` / `:` | Dim blue-grey |
| Floor | `.` | Dim seasonal green / ochre / blue |
| Door / surface gate | `+` | Amber |
| Workshop / planning desk | `=` / `?` | Cool neutral |
| Stockpile / item | `:` / `*` | Dim neutral |
| Stairs / sealed gallery | `>` / `<` | Amber / dim neutral |
| Founder / resident / crew | `@` / `d` / `dd` | Neutral, amber when strained |
| Incident / mandate | `!` / `?` | Muted red / amber |
| Artifact / inspiration | `*` | Violet |
| Rest / sleep / engraving | `~` / `z` / `'` | Neutral / dim violet |

All Fortress glyphs have East Asian width `Na`. The host also accepts box
drawing U+2500–257F, blocks U+2580–259F (often ambiguous `A`), braille
U+2800–28FF (`N`) and halfwidth katakana U+FF66–FF9D (`H`) for other effects.
These enhanced glyphs assume the terminal's ambiguous-width mode is one cell.
Fortress makes no such assumption: it never emits them. `☕`, `⚡`, fullwidth
kana/kanji, variation selectors and emoji are deliberately excluded.

The historical CP437 repertoire inspires the distinction between walls,
floors and inhabitants. No CP437 byte decoding occurs. Enhanced equivalents
include CP437 196 → U+2500 `─`, 179 → U+2502 `│`, 218 → U+250C `┌`, and
219 → U+2588 `█`; Fortress uses ASCII `#` instead for portable alignment.

Semantic RGB values are in `plugins/fx/fortress/render.lua`. Main neutral
lightness is approximately 0.47; amber 0.40, muted red 0.43 and violet 0.51.
Floor and wall detail are deliberately dimmer. The host suppresses global hue
and error tint for Fortress while retaining brightness and user opacity, so an
amber decision does not become a red failure.

Audited render frames for early/middle/late sessions at 80×24, 120×35 and
200×60 are under `tests/golden/fortress/`. Regenerate explicitly with
`lua scripts/world/golden.lua --write`; validate with the same command without
`--write`. The middle 64% of the pane is completely blank. Goldens represent
unoccupied cells; foreground occupancy plus a one-cell halo can only reduce
coverage. Normal density is capped at 15%; user increases stop at 25%.
