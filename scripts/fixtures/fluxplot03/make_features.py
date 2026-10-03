"""Generate ``features.*`` — one fluxplot 0.3.2 figure exercising every payload the colour-system
plan's M5 / M6 items added, so Flux gates read real generator output rather than hand-written JSON.

Run from a fluxplot checkout:
    cd ~/fluxplot && uv run python <flux>/scripts/fixtures/fluxplot03/make_features.py

Panels (named, so ids are stable):
  fit      fp.regression (linear, points + fit + 95% band) and fp.kde (filled)
  twin     fp.line on the primary y, a second fp.line on ax.twinx() (axis: "y2"), fp.step,
           fp.secondary_axis on top (axis.x2 with sampled transform)
  hex      fp.hexmatrix with alpha_by="count" (colorScales[].alpha + data-alpha-value)
  cells    fp.bar with category keys and fp.brackets from fp.stats rows (overlay stats)
  image    fp.image (two channels) + fp.scalebar
Figure scope: fig.suptitle, fig.legend (entries joined to panel-prefixed series), fig.text.
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


def main(variant: str = ""):
    """``variant="b"`` writes ``features-b.*``: the same figure from another draw (seed 4) — the same
    panels, series and member keys with other bar heights, hexagon values and counts — the second
    version a slide morph tweens to (F7)."""
    fx.use_light()
    rng = np.random.default_rng(4 if variant == "b" else 3)
    fig, axes = plt.subplots(2, 3, figsize=(9.6, 5.6), layout="constrained")
    (fit, twin, hexes), (cells, image, spare) = axes
    spare.remove()
    for ax, name in ((fit, "fit"), (twin, "twin"), (hexes, "hex"), (cells, "cells"), (image, "image")):
        fp.panel(ax, name)

    # fit: a regression and a density
    x = np.linspace(0, 10, 30)
    y = 1.5 * x + 2 + rng.normal(0, 2, 30)
    fp.regression(fit, x, y, series="dose", label="Dose response")
    fp.kde(fit, rng.normal(6, 1.5, 120), series="density", fill=True, label="Density")
    fit.set_xlabel("dose")
    fit.set_ylabel("response")

    # twin: two value axes, a step, a secondary x axis
    t = np.arange(0, 12)
    fp.line(twin, t, np.sin(t / 2) + 2, series="rate", label="Rate")
    fp.step(twin, t, (t % 4 == 0).astype(float), series="state", where="post", label="State")
    twin.set_xlabel("time (s)")
    twin.set_ylabel("rate (Hz)")
    right = twin.twinx()
    right.spines["right"].set_visible(True)
    fp.line(right, t, 30 + 5 * np.cos(t / 3), series="temp", label="Temperature", color="#bc5215")
    right.set_ylabel("temperature (°C)")
    fp.secondary_axis(twin, "top", functions=(lambda s: s / 60, lambda m: m * 60), label="time (min)")

    # hex: a density with the count as its opacity channel
    fp.hexmatrix(x=rng.normal(size=500), y=rng.normal(size=500), C=rng.normal(size=500), ax=hexes, gridsize=7,
                 series="mean", alpha_by="count", alpha_range=(0.3, 1.0), colorbar=True, colorbar_label="mean")

    # cells: keyed bars with brackets carrying their test
    groups = {"ctl": rng.normal(1.0, 0.4, 8), "low": rng.normal(1.6, 0.4, 8), "high": rng.normal(2.6, 0.4, 8)}
    fp.bar(cells, list(groups), [v.mean() for v in groups.values()], series="means", label="Mean")
    fp.errorbar(cells, list(groups), [v.mean() for v in groups.values()], yerr=[v.std(ddof=1) for v in groups.values()],
                series="means", fmt="none", capsize=3, color="#100f0f")
    rows = fp.stats.pairwise(fp.stats.welch_hedges, groups)
    fp.brackets(cells, rows, positions={"ctl": 0, "low": 1, "high": 2})
    cells.set_ylabel("value")

    # image: two channels in physical units, a scale bar and one key
    h, w = 12, 16
    dapi = rng.gamma(2.0, 40.0, (h, w))
    gfp = rng.gamma(1.5, 30.0, (h, w))
    im = fp.image(image, np.stack([dapi, gfp]), series="cells", channels=["dapi", "gfp"], luts=["blue", "green"],
                  pixel_size=0.5, units="µm")
    fp.scalebar(image, 2.0, "µm")
    fp.colorbar(im.mappables["gfp"], ax=image, name="gfp", label="GFP", shrink=0.7)

    fig.suptitle("Feature coverage")
    fig.legend(loc="lower right", ncol=3)
    fig.text(0.01, 0.98, "A", fontweight="bold")
    name = "features-b" if variant == "b" else "features"
    fp.save(fig, str(OUT / f"{name}.svg"), recipe=dict(script=os.path.basename(__file__), params={}, inputs=[]),
            _now="2026-09-30T00:00:00Z")
    plt.close(fig)
    print(name, "written to", OUT)


if __name__ == "__main__":
    main()
    main("b")
