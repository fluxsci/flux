"""Generate ``meanmark-ratio.*`` and ``meanmark-pp.*``: two versions of one paired meanmark figure on OTHER UNITS, so Flux gates
read real generator output for an asset Change whose new version re-scales and re-units the value axis.

Run from a fluxplot checkout:
    cd ~/fluxplot && uv run python <flux>/scripts/fixtures/fluxplot03/make_meanmark_units.py

  ratio  amplitude / baseline on a LOG value axis (ticks 0.9 / 1 / 1.1); the intervals are short, so several arms hide inside the
         mean circle (zero-length arm paths) and their caps are drawn in two pieces around it
  pp     the same units and categories as percentage points on a LINEAR axis (ticks at and below zero: -4 / 0 / 4)

The two share series ids, category ids and unit ids (one figure, another measure): the slide Change between them must walk every
mark in a straight line between its rests, move the mean circles whole, and hand the y ticks off (no common tick value).
"""
import os
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import fluxplot as fp  # noqa: E402
from fluxplot import style as fx  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(os.environ.get("FLUX_FEATURES_OUT") or HERE)
CATEGORIES = ["wake", "nrem", "rem"]


def main(variant: str):
    fx.use_light()
    rng = np.random.default_rng(7)
    units = [f"u{i}" for i in range(8)]
    rows = {"x": [], "y": [], "unit": []}
    for c, (centre, spread) in zip(CATEGORIES, ((0.985, 0.006), (1.05, 0.02), (0.99, 0.03))):
        ratio = rng.normal(centre, spread, len(units))
        value = ratio if variant == "ratio" else (ratio - 1.0) * 60.0 - 1.0
        rows["x"] += [c] * len(units); rows["y"] += list(value); rows["unit"] += units
    fig, ax = plt.subplots(figsize=(3.4, 2.4), layout="constrained")
    fp.panel(ax, "main")
    fp.meanmark(rows, x="x", y="y", units="unit", order=CATEGORIES,
                value_scale="log" if variant == "ratio" else "linear")
    if variant == "ratio":
        ax.set_yticks([0.9, 1.0, 1.1], ["0.9", "1", "1.1"])
        ax.set_ylim(0.88, 1.17)
        ax.set_ylabel("Amplitude / baseline")
    else:
        ax.set_ylim(-7.5, 6.8)
        ax.set_ylabel("Excess (percentage points)")
    name = f"meanmark-{variant}"
    fp.save(fig, str(OUT / f"{name}.svg"), recipe=dict(script=os.path.basename(__file__), params={"variant": variant}, inputs=[]),
            _now="2026-10-25T00:00:00Z")
    plt.close(fig)
    print(name, "written to", OUT)


if __name__ == "__main__":
    main("ratio")
    main("pp")
