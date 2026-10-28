"""Reproduce child-rasterizer faces from Flux's existing bundled WOFF2 files.

uv --cache-dir /tmp/flux-font-cache run --with fonttools --with brotli \
    python scripts/build-scene-fonts.py
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "resources/fonts"
OUT.mkdir(parents=True, exist_ok=True)
for weight, label in [(400, "Regular"), (600, "SemiBold"), (700, "Bold")]:
    font = TTFont(ROOT / "src/styles/fonts/Gelasio.woff2", recalcTimestamp=False)
    instantiateVariableFont(font, {"wght": weight}, inplace=True, updateFontNames=True)
    font.flavor = None
    font.save(OUT / f"Gelasio-{label}.ttf")
# The original italic is a static 400 face, despite the CSS variable range.
# Do not invent a new typeface or label it as an authored bold italic.
font = TTFont(ROOT / "src/styles/fonts/Gelasio-italic.woff2", recalcTimestamp=False)
font.flavor = None
font.save(OUT / "Gelasio-Italic.ttf")
