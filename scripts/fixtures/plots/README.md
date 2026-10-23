# Plot fixtures (animation v2)

Real fluxplot 0.1 outputs (svg + `.fluxplot.json` sidecar, recipes omitted) used by the pure
geometry/correspondence/hand-off gates: a box plot (composite series: box/whisker/cap/median/
flier), a 60-point scatter, two bar charts with error bars, two sine-wave lines, and mixed-sign
vertical and horizontal bar charts (`bars_mixed`, `barh_mixed`; per-bar sign and orientation in
`series[].bar`). Never
reference a file outside the repository from a gate — add a fixture here instead.
