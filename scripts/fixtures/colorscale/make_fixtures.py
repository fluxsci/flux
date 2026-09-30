"""Generate the live-colour-scale fixtures (Flux colour-system plan A7 / §8 parity).

Run from a fluxplot checkout:  cd ~/fluxplot && uv run python <flux>/scripts/fixtures/colorscale/make_fixtures.py

Writes, beside this script: ``hexmatrix.*`` (a log-normed hexmatrix with its colour key) and
``heatmap.*`` (a cells=True heatmap with a key), plus ``*-edited.*`` — the SAME scripts rerun by
fluxplot with the recipe colour controls of ``EDITS`` applied (``FLUX_PARAMS``), so a gate can
prove that recolouring live in Flux paints every data-value element exactly as regenerating does.
"""
import json
import os
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import fluxplot as fp  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
# a gate's real-fluxplot leg (verify-colorscale-verb) points this at a scratch plots/ directory
OUT = pathlib.Path(os.environ.get("FLUX_COLORSCALE_OUT") or HERE)
EDITS = {
    "hexmatrix": {"rates": {"cmap": "magma", "vmax": 20}},
    "heatmap": {"m": {"cmap": "crameri.batlow", "vmin": 10, "vmax": 40, "norm": {"kind": "linear"}}},
}


def hexmatrix(ax):
    rng = np.random.default_rng(42)
    wake = 10 ** rng.normal(-0.7, 0.5, 900)
    fp.hexmatrix({"Wake rate (Hz)": wake, "NREM rate (Hz)": wake * 10 ** rng.normal(0, 0.2, 900)},
                 x="Wake rate (Hz)", y="NREM rate (Hz)", ax=ax, xscale="log", yscale="log", norm="log",
                 gridsize=9, cmap="viridis", colorbar_label="Synapses per hexbin", series="rates")


def heatmap(ax):
    rng = np.random.default_rng(7)
    M = rng.uniform(0, 50, (6, 8))
    M[2, 3] = np.nan
    im = fp.heatmap(ax, M, series="m", cells=True, cmap="viridis")
    fp.colorbar(im, label="Value")


def save(name, draw, suffix=""):
    fig, ax = plt.subplots(figsize=(3.4, 2.8), layout="constrained")
    draw(ax)
    fp.save(fig, str(OUT / f"{name}{suffix}.svg"), recipe=dict(script=__file__, params={}, inputs=[]),
            _now="2026-09-30T00:00:00Z")
    plt.close(fig)


def main():
    plots = (("hexmatrix", hexmatrix), ("heatmap", heatmap))
    if os.environ.get("FLUX_PARAMS"):
        # a Flux rerun ("Apply to source"): draw with the controls Flux passed, base names only
        for name, draw in plots:
            save(name, draw)
        return
    for name, draw in plots:
        save(name, draw)
        os.environ["FLUX_PARAMS"] = json.dumps({"__fluxplot__": EDITS[name]})
        save(name, draw, "-edited")
        os.environ.pop("FLUX_PARAMS", None)
    (HERE / "EDITS.json").write_text(json.dumps(EDITS, indent=2) + "\n")
    print("fixtures written to", HERE)


if __name__ == "__main__":
    main()
