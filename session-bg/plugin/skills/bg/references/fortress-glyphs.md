# Fortress glyph and colour vocabulary

Fortress uses ASCII in every terminal. The host gates every Lua `fx:put` and
`sbg.text` character and substitutes `?` for controls, combining marks, emoji,
wide CJK and unaudited characters. Each distinct substitution is logged once
(up to 256 distinct code points) in `fx.log`.

| Role | Glyph | Colour |
|---|---|---|
| Wall / unexcavated vein | `+`, `-`, `\|` / `:` | Blue-grey / dim seasonal |
| Floor | `.` | Dim seasonal green / ochre / blue |
| Door / surface gate | `+` | Amber |
| Workshop / planning desk | `=` / `?` | Cool neutral |
| Stockpile / item | `:` / `*` | Dim neutral |
| Stairs / sealed gallery | `>` / `<` | Amber / dim neutral |
| Founder / resident / crew | `@` / `d` / `dd` | Neutral, amber when strained |
| Incident / mandate | `!` / `?` | Muted red / amber |
| Artifact / inspiration | `*` | Violet |
| Rest / sleep / engraving | `~` / `z` / `'` | Neutral / dim violet |
| Trees / flowers / wheat | `o`, `O`, `^`, `/`, `\|`, `*` | Leaf green / pale gold |
| Stream / crossing | `~`, `=` / `\|=====\|` | Blue / wood |
| Rocks / mushrooms | `.`, `-`, `_`, `(`, `)` | Stone / violet |
| Rabbits / butterflies | `(o.o)` / `>o<` | Warm neutral / pale gold |

All Fortress glyphs have East Asian width `Na`. The host also accepts box
drawing U+2500–257F, blocks U+2580–259F (often ambiguous `A`), braille
U+2800–28FF (`N`) and halfwidth katakana U+FF66–FF9D (`H`) for other effects.
It also accepts the curated symbols `· • ∙ ● ☺ ☻ ♟ ♙ ⚙ ✎ ⌨ ▣ ▤ ▥ ▦ ▧ ▨ ▩ ♥ ★ ✦ ✧
☁ ☂ ☀ ☾ ♠ ♣ °` and, for the Studio scene, `⌂ ⎇ ▰ ▱ ◉ ◆ ◇ ■ ○ ¤ ✓ ✗ ⋯ ◘ ☼`.
`accepted_glyphs_are_single_cell` in `plugins/src/frame.rs` checks every
accepted code point against `unicode-width`. These enhanced glyphs assume the
terminal's ambiguous-width mode is one cell. The settlement scene makes no such
assumption: it never emits them. `☕`, `⚡`, `▪`, `▶`, `✔`, fullwidth kana/kanji,
variation selectors and emoji are deliberately excluded.

The historical CP437 repertoire inspires the distinction between walls,
floors and inhabitants. No CP437 byte decoding occurs. Enhanced equivalents
include CP437 196 → U+2500 `─`, 179 → U+2502 `│`, 218 → U+250C `┌`, and
219 → U+2588 `█`; Fortress uses ASCII outlines for portable alignment.

The Studio scene draws its tower from the vocabulary in
`plugins/fx/fortress/glyphs.lua`: `╔═╗║╚╝╟╢─` for the frame, `╫` (Garage) or
`╎` for the shaft, `▣⌨` desks, `▤` boards, `▦` racks, `▥` shelves, `▙` coffee,
`▄` couch, `♣` plants, `☼` window, `▐` owner's door and `♠☂` on the Tower
terrace. `sbg set glyphs=ascii` swaps every glyph for its one-cell ASCII
equivalent in the same table (`+=|-H:#%_c*o]`); `?` stays reserved for the host's substitution mark. The tower's static layer stays
within 70% of the density budget by shedding decor, then duplicate furniture,
then floors. Studio colours are in `plugins/fx/fortress/studioview.lua`.

Semantic RGB values are in `plugins/fx/fortress/render.lua`. Silhouettes use
brighter source colours to survive idle brightness ×0.8 and default compositor
opacity 0.6; floor texture remains dimmer. Local night shading bottoms out at
0.82 for legibility. The host suppresses global hue
and error tint for Fortress while retaining brightness and user opacity, so an
amber decision does not become a red failure.

Audited render frames for early/middle/late sessions at 80×24, 120×35 and
200×60 are under `tests/golden/fortress/`. Regenerate explicitly with
`lua scripts/world/golden.lua --write`; validate with the same command without
`--write`. Default scenery fills empty space across the body of the pane;
explicit `presentation=compact` keeps the middle 64% blank. Goldens represent
unoccupied cells; foreground occupancy plus a one-cell halo can only reduce
coverage. Normal density targets 22% (15% compact); user increases stop at 25%.
