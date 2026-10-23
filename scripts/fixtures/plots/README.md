# Plot fixtures (animation v2)

Real fluxplot 0.1 outputs (svg + `.fluxplot.json` sidecar, recipes omitted) used by the pure
geometry/correspondence/hand-off gates: a box plot (composite series: box/whisker/cap/median/
flier), a 60-point scatter, two bar charts with error bars, two sine-wave lines, and mixed-sign
vertical and horizontal bar charts (`bars_mixed`, `barh_mixed`; per-bar sign and orientation in
`series[].bar`).

Release 2 (WP 2.3) adds fluxplot 0.1 outputs for the data gates: `mpl_bars_5` / `mpl_bars_10` (the same
chart at 5 and 10 bins, `verify-bar-grow`) and `log_line` (a marker line on a log-10 x axis,
`verify-plot-tick-handoff`). Never
reference a file outside the repository from a gate — add a fixture here instead.
