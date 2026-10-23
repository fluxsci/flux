// Synthetic band-power plots shaped like the owner's (2026-10-23 X-ray context work):
// a categorical x axis whose labels wrap ("Quiet\nwake"), a titled y axis, line series
// and a scatter series of `points` markers. Real research plots never enter the repo.
export const CATS = ["Quiet\nwake", "Active\nwake", "SWS", "Sigma\nsleep", "REM"];

export function bandpowerManifest(yTitle, yTicks, points = 23) {
  const pointIds = Array.from({ length: points }, (_, i) => `quiet-wake-acquisitions.point.${i}`);
  return {
    spec: "fluxplot", schemaVersion: "0.3.0", plotType: "line", svg: "", size: { width: 300, height: 200, unit: "px" },
    axes: [{
      x: { scale: "category", label: "", domain: [0, 4], anchors: [{ data: 0, svg: 40 }, { data: 4, svg: 280 }], ticks: CATS.map((label, value) => ({ value, label })) },
      y: { scale: "linear", label: yTitle, domain: [0, 1], anchors: [{ data: 0, svg: 180 }, { data: 1, svg: 20 }], ticks: yTicks.map((label, value) => ({ value, label })) },
    }],
    series: [
      { id: "acq-1-soma1", name: "acq_1__soma1", svg: { line: "acq-1-soma1.line" } },
      { id: "quiet-wake-acquisitions", kind: "scatter", svg: { points: "quiet-wake-acquisitions.points" }, points: pointIds.map((svgId, index) => ({ index, svgId, x: 0, y: index })), color: { hex: "#879a39" } },
    ],
    build: { order: [] },
    parts: {
      id: "figure", role: "figure", kind: "container", children: [{ ref: "figure.title", role: "title", kind: "text" }, {
        id: "plot-area", role: "plot-area", kind: "container", children: [
          { id: "axis.x", role: "axis", axis: "x", kind: "container", children: [
            { ref: "axis.x.spine", kind: "line" },
            { id: "axis.x.ticks", role: "group", groupRole: "tick", kind: "line", members: CATS.map((_, i) => `axis.x.tick.${i}`) },
            { id: "axis.x.tick-labels", role: "group", groupRole: "tick-label", kind: "text", members: CATS.map((_, i) => `axis.x.ticklabel.${i}`) },
          ] },
          { id: "axis.y", role: "axis", axis: "y", kind: "container", children: [
            { ref: "axis.y.spine", kind: "line" },
            { id: "axis.y.ticks", role: "group", groupRole: "tick", kind: "line", members: yTicks.map((_, i) => `axis.y.tick.${i}`) },
            { id: "axis.y.tick-labels", role: "group", groupRole: "tick-label", kind: "text", members: yTicks.map((_, i) => `axis.y.ticklabel.${i}`) },
            { ref: "axis.y.title", kind: "text" },
          ] },
          { id: "acq-1-soma1", role: "series", kind: "container", children: [{ ref: "acq-1-soma1.line", kind: "line" }] },
          { id: "quiet-wake-acquisitions", role: "series", kind: "container", children: [
            { id: "quiet-wake-acquisitions.points", role: "group", groupRole: "point", kind: "shape", members: pointIds },
          ] },
        ],
      }],
    },
  };
}

/** The drawing: real positions, so canvas outlines have boxes to measure. */
export function bandpowerSvg(title, yTitle, yTicks, points = 23) {
  const x = (i) => 40 + i * 60, y = (i) => 180 - (i * 160) / Math.max(1, yTicks.length - 1);
  const t = [];
  t.push(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><g id="figure">`);
  t.push(`<text id="figure.title" x="150" y="14" font-size="12" text-anchor="middle" fill="#100f0f">${title}</text>`);
  t.push(`<path id="axis.x.spine" d="M40 180H280" stroke="#100f0f"/><path id="axis.y.spine" d="M40 20V180" stroke="#100f0f"/>`);
  CATS.forEach((c, i) => {
    t.push(`<path id="axis.x.tick.${i}" d="M${x(i)} 180v4" stroke="#100f0f"/>`);
    t.push(`<g id="axis.x.ticklabel.${i}">${c.split("\n").map((l, k) => `<text x="${x(i)}" y="${194 + k * 6}" font-size="6" text-anchor="middle" fill="#100f0f">${l}</text>`).join("")}</g>`);
  });
  yTicks.forEach((v, i) => {
    t.push(`<path id="axis.y.tick.${i}" d="M40 ${y(i)}h-4" stroke="#100f0f"/>`);
    t.push(`<g id="axis.y.ticklabel.${i}"><text x="34" y="${y(i) + 2}" font-size="6" text-anchor="end" fill="#100f0f">${v}</text></g>`);
  });
  t.push(`<text id="axis.y.title" x="12" y="100" font-size="7" transform="rotate(-90 12 100)" text-anchor="middle" fill="#100f0f">${yTitle}</text>`);
  t.push(`<path id="acq-1-soma1.line" d="M${x(0)} 150L${x(1)} 120L${x(2)} 90L${x(3)} 60L${x(4)} 140" fill="none" stroke="#da702c"/>`);
  t.push(`<g id="quiet-wake-acquisitions.points">${Array.from({ length: points }, (_, i) => `<circle id="quiet-wake-acquisitions.point.${i}" cx="${40 + (i % 50) * 4.8}" cy="${30 + Math.floor(i / 50) * 3 % 140}" r="1.5" fill="#879a39"/>`).join("")}</g>`);
  t.push(`</g></svg>`);
  return t.join("");
}
