#!/usr/bin/env python3
"""
Generate the AGENTIQ brand marks as SVG.

Letterforms are extracted as real outlines from Inter ExtraBold: the same
typeface the application self-hosts via @fontsource, so the logo and the UI
share one voice instead of merely resembling each other.

Change MONOGRAM below and re-run to produce the same marks for other initials:

    python3 scripts/generate-logo.py

Output lands in web/public/brand/.
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.misc.transform import Transform

# ── Change these ─────────────────────────────────────────────────────────────
MONOGRAM = "AQ"
WORDMARK = "AGENTIQ"

# ── Palette: lifted from web/src/index.css @theme, not re-invented ───────────
INK        = "#131A24"
PRIMARY    = "#1B4D89"
PRIMARY_700= "#143A68"
ACCENT     = "#2563C9"
WHITE      = "#FFFFFF"

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "node_modules/@fontsource/inter/files/inter-latin-800-normal.woff2"
OUT  = ROOT / "web/public/brand"

SIZE = 512
CX = CY = SIZE / 2
R_OUT = 224.0          # hexagon circumradius
BAND  = 30.0           # frame thickness for the outline variant


def hexagon(cx, cy, r, pointy=True):
    """Regular hexagon path. Pointy-top: a vertex at 12 o'clock, flat L/R sides."""
    import math
    start = 90 if pointy else 0
    pts = []
    for i in range(6):
        a = math.radians(start + 60 * i)
        pts.append((cx + r * math.cos(a), cy - r * math.sin(a)))
    d = f"M{pts[0][0]:.2f} {pts[0][1]:.2f}"
    for x, y in pts[1:]:
        d += f"L{x:.2f} {y:.2f}"
    return d + "Z"


def inset_radius(r, d):
    """Circumradius of a hexagon whose edges sit `d` inside the original's."""
    return r - d / (3 ** 0.5 / 2)


class Run:
    """A laid-out string of glyph outlines, in font units, y-up."""

    def __init__(self, font, text, tracking=0.0):
        self.font = font
        self.upem = font["head"].unitsPerEm
        self.glyphset = font.getGlyphSet()
        cmap = font.getBestCmap()
        hmtx = font["hmtx"]
        os2 = font["OS/2"]
        self.cap = getattr(os2, "sCapHeight", None) or int(self.upem * 0.727)

        self.items = []          # (glyphName, xOffset)
        x = 0.0
        for ch in text:
            gname = cmap[ord(ch)]
            self.items.append((gname, x))
            x += hmtx[gname][0] + tracking * self.upem
        self.advance = x

        # True outline bounds, curves included, not the advance box.
        x0 = y0 = float("inf")
        x1 = y1 = float("-inf")
        for gname, xo in self.items:
            bp = BoundsPen(self.glyphset)
            self.glyphset[gname].draw(TransformPen(bp, Transform().translate(xo, 0)))
            if bp.bounds is None:
                continue
            bx0, by0, bx1, by1 = bp.bounds
            x0, y0 = min(x0, bx0), min(y0, by0)
            x1, y1 = max(x1, bx1), max(y1, by1)
        self.bounds = (x0, y0, x1, y1)

    def fitted_path(self, box_w, box_h, cx, cy):
        """Fit to box_w x box_h and centre optically on (cx, cy), flipped to y-down.

        Vertical fit and centring both use the CAP BAND (baseline to cap height),
        not the ink bounds. Q's tail drops well below the baseline, so centring on
        ink would push A and Q visibly above the middle of the hexagon and make
        the letters read as sitting too high.
        """
        x0, _, x1, _ = self.bounds
        w = x1 - x0
        s = min(box_w / w, box_h / self.cap)

        t = (Transform()
             .translate(cx, cy)
             .scale(s, -s)
             .translate(-(x0 + x1) / 2, -self.cap / 2))

        out = []
        for gname, xo in self.items:
            pen = SVGPathPen(self.glyphset, ntos=lambda v: f"{v:.2f}")
            self.glyphset[gname].draw(TransformPen(pen, t.translate(xo, 0)))
            d = pen.getCommands()
            if d:
                out.append(d)
        return " ".join(out), s


def svg(body, size=SIZE, w=None, h=None, title=""):
    vb = f"0 0 {w or size} {h or size}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" '
        f'width="{w or size}" height="{h or size}" role="img" aria-label="{title}">\n'
        f"{body}\n</svg>\n"
    )


def main():
    if not FONT.exists():
        raise SystemExit(f"Inter ExtraBold not found at {FONT}. Run `npm install` first.")

    font = TTFont(FONT)
    OUT.mkdir(parents=True, exist_ok=True)

    hex_out = hexagon(CX, CY, R_OUT)
    hex_in  = hexagon(CX, CY, inset_radius(R_OUT, BAND))

    mono = Run(font, MONOGRAM, tracking=-0.02)

    # ── 1. Solid hexagon, letters knocked out ────────────────────────────────
    # One path, fill-rule evenodd: the hexagon is region 1, each letter's outer
    # contour is region 2 (a hole), each counter is region 3 (solid again). That
    # is exactly how a knockout should behave, and it survives any renderer.
    letters, _ = mono.fitted_path(232, 122, CX, CY)
    solid = svg(
        f'  <path fill="{PRIMARY}" fill-rule="evenodd" d="{hex_out} {letters}"/>',
        title=f"{MONOGRAM} monogram",
    )
    (OUT / "mark-solid.svg").write_text(solid)

    # ── 2. Hexagon frame, solid letters ──────────────────────────────────────
    letters2, _ = mono.fitted_path(238, 124, CX, CY)
    outline = svg(
        f'  <path fill="{PRIMARY}" fill-rule="evenodd" d="{hex_out} {hex_in}"/>\n'
        f'  <path fill="{PRIMARY}" d="{letters2}"/>',
        title=f"{MONOGRAM} monogram, framed",
    )
    (OUT / "mark-framed.svg").write_text(outline)

    # ── 3. Two-tone: frame in primary, letters in accent ─────────────────────
    duo = svg(
        f'  <path fill="{PRIMARY}" fill-rule="evenodd" d="{hex_out} {hex_in}"/>\n'
        f'  <path fill="{ACCENT}" d="{letters2}"/>',
        title=f"{MONOGRAM} monogram, two tone",
    )
    (OUT / "mark-duotone.svg").write_text(duo)

    # ── 4. Reversed, for dark backgrounds ────────────────────────────────────
    rev = svg(
        f'  <path fill="{WHITE}" fill-rule="evenodd" d="{hex_out} {letters}"/>',
        title=f"{MONOGRAM} monogram, reversed",
    )
    (OUT / "mark-reversed.svg").write_text(rev)

    # ── 5. Horizontal lockup: mark + wordmark ────────────────────────────────
    LOCK_H = 160
    scale = LOCK_H / SIZE
    word = Run(font, WORDMARK, tracking=0.012)
    # Wordmark cap height ~46px reads as a peer to a 160px mark, not a caption.
    gap = 34
    mark_w = LOCK_H
    wx0 = mark_w + gap
    word_h = 46
    word_w = word_h * ((word.bounds[2] - word.bounds[0]) / (word.bounds[3] - word.bounds[1]))
    total_w = wx0 + word_w + 4
    wpath, _ = word.fitted_path(word_w, word_h, wx0 + word_w / 2, LOCK_H / 2)

    lockup = svg(
        f'  <g transform="scale({scale:.5f})">\n'
        f'    <path fill="{PRIMARY}" fill-rule="evenodd" d="{hex_out} {letters}"/>\n'
        f"  </g>\n"
        f'  <path fill="{INK}" d="{wpath}"/>',
        w=round(total_w), h=LOCK_H, title=f"{WORDMARK} logo",
    )
    (OUT / "lockup.svg").write_text(lockup)

    # ── 6. Favicon: single letter, tuned for 32px ────────────────────────────
    # At favicon size a two-letter monogram turns to mud, so the mark drops to
    # its first letter and the hexagon gets a touch more breathing room.
    one = Run(font, MONOGRAM[0])
    fav_letter, _ = one.fitted_path(178, 178, CX, CY)
    fav = svg(
        f'  <path fill="{PRIMARY}" fill-rule="evenodd" d="{hexagon(CX, CY, 246)} {fav_letter}"/>',
        title="AGENTIQ",
    )
    (OUT / "favicon.svg").write_text(fav)

    for f in sorted(OUT.iterdir()):
        print(f"  {f.relative_to(ROOT)}  ({f.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
