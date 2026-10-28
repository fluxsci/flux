These TrueType faces are derived solely from Flux's existing Gelasio WOFF2 files
in `src/styles/fonts/`. They let the out-of-process SVG rasterizer use the same
authored font as Chromium; resvg cannot read embedded WOFF2 webfonts.

`Gelasio-Regular.ttf`, `Gelasio-SemiBold.ttf`, and `Gelasio-Bold.ttf` are static
instances at weights 400, 600, and 700 of the existing normal variable face.
`Gelasio-Italic.ttf` is the existing static italic 400 face decompressed.
`scripts/build-scene-fonts.py` reproduces them using FontTools and Brotli in an
isolated environment. FontTools is a development conversion tool, never a runtime
dependency. No new font was downloaded.

Copyright 2022 The Gelasio Project Authors (https://github.com/SorkinType/Gelasio).
The upstream SIL Open Font License 1.1 is included in `OFL.txt`.
