# AGENTIQ brand marks

Generated, not hand-drawn. Run `python3 scripts/generate-logo.py` to rebuild
every file here. To produce the same set for different initials, change
`MONOGRAM` at the top of that script and re-run.

## Why it is generated

The letterforms are real outlines extracted from **Inter ExtraBold**: the
typeface the app already self-hosts via `@fontsource`. The logo and the
interface therefore share one voice rather than merely resembling each other,
and nothing depends on a font being installed at render time: every glyph is
baked into the SVG as path data.

Colours come from the `@theme` block in `web/src/index.css`. They are not
re-invented here, so the marks cannot drift from the UI palette.

## The files

| File | Use |
|---|---|
| `mark-solid.svg` | Default. Solid hexagon, letters knocked out. |
| `mark-framed.svg` | Hexagon outline with solid letters. Lighter on the page. |
| `mark-duotone.svg` | Frame in primary, letters in accent. |
| `mark-reversed.svg` | White. For dark backgrounds only. |
| `lockup.svg` | Mark plus the AGENTIQ wordmark, horizontal. |
| `favicon.svg` | Single letter. Copied to `web/public/favicon.svg`. |
| `png/` | 1024px rasters (1600px lockup) for slides and the report. |

## Rules

- **Below ~32px, use `favicon.svg`.** Two letters turn to mud at that size;
  the favicon variant drops to a single letter for exactly this reason.
- **`mark-reversed.svg` is white on transparent.** It is invisible on a light
  background. That is the point.
- Prefer the SVGs everywhere. The PNGs exist only for tools that cannot place
  vectors. Word, PowerPoint, Canva and Figma all import SVG directly.
- Keep clear space around the mark equal to half the hexagon's width.

## Regenerating the PNGs

The SVGs are the source of truth and are committed. The PNGs were rasterised
with `sharp` at density 600. Note that macOS `qlmanage` is **not** a usable
substitute: it force-pads to a square and clips wide art such as the lockup.
