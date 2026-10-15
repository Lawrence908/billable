#!/usr/bin/env python3
"""Build billable's favicon set: a stopwatch on the house rounded square.

Writes src/favicon.svg (standard library only), and, when cairosvg and Pillow
are available, src/favicon.ico (48/32/16) and src/apple-touch-icon.png (180).
Adapted from econ-core/tools/build-favicons.py; colours are app.css --bg and
--accent.

    uv run --with cairosvg --with pillow tools/build-favicons.py
"""

import io
import os

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")

INK = "#16181c"     # --bg
ACCENT = "#f0b23e"  # --accent
PAPER = "#e8e4da"   # --ink

SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <title>billable</title>
  <rect width="64" height="64" rx="13" fill="{INK}"/>
  <g fill="none" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="32" cy="36" r="17" stroke="{ACCENT}"/>
  <path d="M32 36V27" stroke="{PAPER}"/>
  <path d="M27 10h10" stroke="{ACCENT}"/>
  </g>
</svg>
"""


def main():
    with open(os.path.join(SRC, "favicon.svg"), "w") as fh:
        fh.write(SVG)
    try:
        import cairosvg
        from PIL import Image
    except ImportError:
        print("favicon.svg only (cairosvg/Pillow missing)")
        return
    raw = SVG.encode()
    cairosvg.svg2png(bytestring=raw, write_to=os.path.join(SRC, "apple-touch-icon.png"),
                     output_width=180, output_height=180)
    # Largest first: Pillow silently drops sizes bigger than the base image.
    frames = [Image.open(io.BytesIO(cairosvg.svg2png(bytestring=raw, output_width=s, output_height=s))).convert("RGBA")
              for s in (48, 32, 16)]
    ico = os.path.join(SRC, "favicon.ico")
    frames[0].save(ico, format="ICO", sizes=[f.size for f in frames], append_images=frames[1:])
    got = sorted(Image.open(ico).info.get("sizes", set()))
    assert got == [(16, 16), (32, 32), (48, 48)], got
    print("favicon.svg, favicon.ico", got, "apple-touch-icon.png")


if __name__ == "__main__":
    main()
