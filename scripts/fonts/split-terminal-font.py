"""
Split a Nerd Font into two WOFF2 faces that share one family name:

- base:    the text a terminal draws all the time — Latin, Greek, Cyrillic,
           punctuation, arrows, maths, box drawing, blocks, braille spinners.
- symbols: everything else in the font (Nerd Font icons, Powerline, the rest
           of the private use area).

`@font-face` gives each a `unicode-range`, so a browser downloads the
symbols face only when a pane actually draws one of those glyphs. The base
face is what a terminal waits on before measuring its cell
(`src/lib/terminal-font.ts`). `src/App.css` repeats BASE_RANGES as the base
faces' `unicode-range`; keep the two in step.

Run with: scripts/fonts/split-terminal-fonts.sh
"""

import sys
from fontTools import subset
from fontTools.ttLib import TTFont

BASE_RANGES = [
    (0x0000, 0x024F),  # Basic Latin, Latin-1, Latin Extended-A/B
    (0x0250, 0x02FF),  # IPA, spacing modifiers
    (0x0300, 0x036F),  # combining diacritics
    (0x0370, 0x03FF),  # Greek
    (0x0400, 0x04FF),  # Cyrillic
    (0x1E00, 0x1EFF),  # Latin Extended Additional
    (0x2000, 0x206F),  # general punctuation
    (0x2070, 0x209F),  # super/subscripts
    (0x20A0, 0x20CF),  # currency
    (0x2100, 0x214F),  # letterlike
    (0x2150, 0x218F),  # number forms
    (0x2190, 0x21FF),  # arrows
    (0x2200, 0x22FF),  # maths
    (0x2300, 0x23FF),  # misc technical
    (0x2400, 0x243F),  # control pictures
    (0x2460, 0x24FF),  # enclosed alphanumerics
    (0x2500, 0x257F),  # box drawing
    (0x2580, 0x259F),  # block elements
    (0x25A0, 0x25FF),  # geometric shapes
    (0x2600, 0x26FF),  # misc symbols
    (0x2700, 0x27BF),  # dingbats
    (0x27C0, 0x27FF),  # misc maths A / arrows
    (0x2800, 0x28FF),  # braille (spinners)
    (0x2900, 0x297F),  # supplemental arrows
    (0xFFFD, 0xFFFD),  # replacement character
]


def in_base(cp):
    return any(lo <= cp <= hi for lo, hi in BASE_RANGES)


def write(src, out, codepoints):
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    font = TTFont(src)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(out)


def main(src, base_out, symbols_out):
    cmap = TTFont(src).getBestCmap()
    base = [cp for cp in cmap if in_base(cp)]
    symbols = [cp for cp in cmap if not in_base(cp)]
    write(src, base_out, base)
    write(src, symbols_out, symbols)


if __name__ == "__main__":
    main(*sys.argv[1:4])
