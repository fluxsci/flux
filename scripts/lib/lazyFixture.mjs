// Dense N-figure project generator for the lazy-asset gates + probes
// (notes/lazy_figure_asset_loading_plan.md Phase 0).
//
// Writes a synthetic project into the ?fixture=demo memBridge (window.fig)
// and returns its layout, so gates can drive `__flux.bridge.loadFigInto(root)`
// against a project whose SHAPE mirrors the measured real-world case (the
// rasterized FluxProjection figure: 14 panels, ~30.8k element tags, ~5.5 MB
// of SVG per figure) without committing megabytes of fixtures to the repo.
//
// Per-panel structure mirrors post-rasterization fluxplot output: axes spines,
// gridlines, one series line + a dense point cloud (the element-count knob),
// tick labels (g>text>tspan), and an XML comment as byte padding (parses and
// retains like real base64-raster bulk, but paints nothing — keeps paint cost
// out of what the gates measure). A sidecar .fluxplot.json marks each panel a
// REAL fluxplot (non-derived manifest); `vanillaPerFigure` adds sidecar-less
// panels for the derived-manifest path.

/** In-page builder. Runs inside page.evaluate — no outer-scope references. */
async function buildDenseProject(cfg) {
  const enc = (n) => String(n);
  const PANEL_W = 460;
  const PANEL_H = 345;
  const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNiYGBgAAAABQAB" +
    "h6FO1AAAAABJRU5ErkJggg==";

  function panelSvg(seed, elems, targetBytes, panelIdx) {
    const K = Math.max(0, elems - 48); // point-cloud size ⇒ total ≈ `elems` element tags
    const parts = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `viewBox="0 0 ${PANEL_W} ${PANEL_H}" width="${PANEL_W}" height="${PANEL_H}">`,
    );
    parts.push(`<g id="figure_1">`);
    parts.push(`<rect id="patch_1" x="0" y="0" width="${PANEL_W}" height="${PANEL_H}" fill="#ffffff"/>`);
    parts.push(`<g id="axes_1">`);
    for (let i = 0; i < 4; i++)
      parts.push(`<path id="spine_${i}" d="M40 ${20 + i * 5} L${PANEL_W - 20} ${20 + i * 5}" stroke="#100f0f" fill="none"/>`);
    for (let i = 0; i < 6; i++)
      parts.push(`<path id="grid_${i}" d="M40 ${40 + i * 45} L${PANEL_W - 20} ${40 + i * 45}" stroke="#e6e4d9" fill="none"/>`);
    // series line: one polyline path
    let d = `M40 ${170 + ((seed * 7) % 40)}`;
    for (let i = 1; i < 200; i++) {
      const x = 40 + (i * (PANEL_W - 60)) / 200;
      const y = 170 + 60 * Math.sin(i / (9 + (seed % 5))) * Math.cos(i / 23);
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    parts.push(`<g id="s0.line"><path d="${d}" stroke="#4385be" fill="none" stroke-width="1.2"/></g>`);
    // dense point cloud — the element-count knob
    parts.push(`<g id="s0.points">`);
    for (let i = 0; i < K; i++) {
      const x = 40 + (((seed * 131 + i * 17) % 1000) / 1000) * (PANEL_W - 60);
      const y = 30 + (((seed * 37 + i * 71) % 1000) / 1000) * (PANEL_H - 60);
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.1" fill="#da702c"/>`);
    }
    parts.push(`</g>`);
    for (let i = 0; i < 10; i++) {
      parts.push(
        `<g id="ticklabel_${i}"><text x="${40 + i * 38}" y="${PANEL_H - 8}" font-size="8" fill="#100f0f">` +
          `<tspan>${enc(i * 10)}</tspan></text></g>`,
      );
    }
    parts.push(`<image x="${PANEL_W - 18}" y="4" width="12" height="12" xlink:href="data:image/png;base64,${TINY_PNG}"/>`);
    parts.push(`<text id="title" x="${PANEL_W / 2}" y="14" font-size="10" text-anchor="middle">Panel ${panelIdx}</text>`);
    parts.push(`</g></g>`);
    parts.push(`</svg>`);
    let svg = parts.join("\n");
    // Byte padding: an XML comment. DOMParser chews the bytes (parse-time
    // realism for the base64-raster bulk real panels carry) but it renders
    // nothing, so paint cost stays out of the measurements.
    const deficit = targetBytes - svg.length;
    if (deficit > 30) {
      svg = svg.replace("</svg>", `<!-- ${"x".repeat(deficit - 12)} -->\n</svg>`);
    }
    return svg;
  }

  const root = cfg.root;
  const F = window.fig;
  await F.mkdir?.(`${root}/fig`);
  await F.mkdir?.(`${root}/fig/canvases`);
  await F.mkdir?.(`${root}/fig/assets`);

  const indexAssets = [];
  const figures = [];
  const figIds = [];
  const assetsByFig = {};
  const COLS = 4;
  const PITCH_X = 4000; // far apart: only the active figure's neighborhood culls in
  const PITCH_Y = 3000;
  let seed = 1;
  for (let f = 0; f < cfg.figures; f++) {
    const figId = `lazyfig-${f + 1}`;
    figIds.push(figId);
    const elements = [];
    const figAssets = [];
    const total = cfg.panels + (cfg.vanillaPerFigure || 0);
    for (let p = 0; p < total; p++) {
      const vanilla = p >= cfg.panels;
      const aid = `lazyasset-${f + 1}-${p + 1}${vanilla ? "-v" : ""}`;
      const svg = panelSvg(seed++, cfg.elemsPerPanel, cfg.panelBytes, p + 1);
      await F.writeText(`${root}/fig/assets/${aid}.svg`, svg);
      if (!vanilla) {
        await F.writeText(
          `${root}/fig/assets/${aid}.fluxplot.json`,
          JSON.stringify({
            schemaVersion: "0.3.0",
            title: `Panel ${p + 1}`,
            series: [{ id: "s0", svg: { line: "s0.line", points: "s0.points" } }],
          }),
        );
      }
      indexAssets.push({
        id: aid,
        kind: "svg",
        path: `assets/${aid}.svg`,
        name: `${aid}.svg`,
        naturalWidth: 460,
        naturalHeight: 345,
      });
      figAssets.push(aid);
      const col = p % 4;
      const row = Math.floor(p / 4);
      elements.push({
        type: "plot",
        id: `lazyel-${f + 1}-${p + 1}`,
        assetId: aid,
        x: 10 + col * 302,
        y: 10 + row * 210,
        width: 292,
        height: 200,
        rotation: 0,
        source: { svgPath: `plots/${aid}.svg` },
        overrides: {},
      });
    }
    assetsByFig[figId] = figAssets;
    figures.push({
      id: figId,
      name: `Lazy ${f + 1}`,
      canvasId: "canvas-1",
      x: (f % COLS) * PITCH_X,
      y: Math.floor(f / COLS) * PITCH_Y,
      width: 1240,
      height: 880,
      background: "#ffffff",
      elements,
    });
  }

  await F.writeText(
    `${root}/fig/canvases/canvas-1.json`,
    JSON.stringify({ schemaVersion: "0.1.0", id: "canvas-1", name: "Canvas 1", figures }),
  );
  await F.writeText(
    `${root}/fig/index.json`,
    JSON.stringify({
      schemaVersion: "0.1.0",
      canvases: [{ id: "canvas-1", name: "Canvas 1", order: 1 }],
      figures: figIds.map((id, i) => ({
        id,
        name: `Lazy ${i + 1}`,
        label: `lazy-${i + 1}`,
        order: i + 1,
        kind: "main",
        canvas: "canvas-1",
        caption: "",
      })),
      assets: indexAssets,
      palette: [],
    }),
  );
  return { root, figIds, assetsByFig };
}

/** Write a dense synthetic project into the memBridge and return
 *  { root, figIds, assetsByFig }. Page must already be on ?fixture=demo. */
export async function installDenseProject(page, opts = {}) {
  const cfg = {
    root: "/demo/lazy-scale",
    figures: 12,
    panels: 14,
    elemsPerPanel: 2180, // ≈ real rasterized projection density (30.5k/figure)
    panelBytes: 380_000, // ≈ real per-panel byte weight (5.3 MB/figure)
    vanillaPerFigure: 0,
    ...opts,
  };
  return page.evaluate(buildDenseProject, cfg);
}
